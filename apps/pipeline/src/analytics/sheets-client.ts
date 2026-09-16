import { readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

interface SheetsClientOptions {
  clientSecretFile: string;
  tokensFile: string;
}

export class SheetsClient {
  private sheets;

  private constructor(auth: OAuth2Client) {
    this.sheets = google.sheets({ version: "v4", auth });
  }

  static async create(opts: SheetsClientOptions): Promise<SheetsClient> {
    const raw = await readFile(opts.clientSecretFile, "utf-8");
    const creds = JSON.parse(raw);
    const { client_id, client_secret, redirect_uris } =
      creds.installed ?? creds.web;

    const oauth2 = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0] ?? "http://localhost",
    );

    // Try loading saved tokens
    let tokens: Record<string, unknown> | null = null;
    try {
      const saved = await readFile(opts.tokensFile, "utf-8");
      tokens = JSON.parse(saved);
    } catch {
      // No saved tokens — need interactive flow
    }

    if (tokens) {
      oauth2.setCredentials(tokens);
    } else {
      tokens = await runInteractiveAuth(oauth2, opts.tokensFile);
      oauth2.setCredentials(tokens);
    }

    return new SheetsClient(oauth2);
  }

  async createSpreadsheet(
    title: string,
    sheetNames: string[],
  ): Promise<string> {
    const res = await this.sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: sheetNames.map((name) => ({
          properties: { title: name },
        })),
      },
    });
    const id = res.data.spreadsheetId;
    if (!id) throw new Error("Spreadsheet creation did not return an ID");
    return id;
  }

  async readRange(spreadsheetId: string, range: string): Promise<string[][]> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    return (res.data.values as string[][]) ?? [];
  }

  async writeRange(
    spreadsheetId: string,
    range: string,
    values: (string | number)[][],
  ): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  }
}

async function runInteractiveAuth(
  oauth2: OAuth2Client,
  tokensFile: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400);
          res.end("Missing code parameter");
          return;
        }

        const { tokens } = await oauth2.getToken({
          code,
          redirect_uri: `http://localhost:${port}`,
        });

        await writeFile(tokensFile, JSON.stringify(tokens, null, 2));

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Authorization successful!</h1><p>You can close this tab.</p>",
        );
        server.close();
        resolve(tokens as Record<string, unknown>);
      } catch (err) {
        res.writeHead(500);
        res.end("Authorization failed");
        server.close();
        // Clean up stale tokens
        try {
          await unlink(tokensFile);
        } catch {}
        reject(err);
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start local auth server"));
        return;
      }
      port = addr.port;

      const authUrl = oauth2.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/spreadsheets"],
        redirect_uri: `http://localhost:${port}`,
      });

      console.log(`\nOpen this URL to authorize:\n${authUrl}\n`);

      // Try to open browser
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      Bun.spawn([cmd, authUrl], { stdio: ["ignore", "ignore", "ignore"] });
    });

    let port = 0;
  });
}
