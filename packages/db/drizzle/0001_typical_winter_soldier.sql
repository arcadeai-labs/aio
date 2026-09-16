CREATE TABLE "citations" (
	"id" serial PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"cited_text" text,
	"start_index" integer,
	"end_index" integer
);
--> statement-breakpoint
CREATE TABLE "competitor_cited_urls" (
	"id" serial PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"competitor_name" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_mentions" (
	"id" serial PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"competitor_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"alias" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_competitors" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_owned_domains" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"domain" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "config_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_date" date NOT NULL,
	"brand_name" text NOT NULL,
	"ground_truth_description" text,
	"judge_provider" text,
	"judge_model" text,
	"raw" jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_snapshots_run_date_unique" UNIQUE("run_date")
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"run_date" date PRIMARY KEY NOT NULL,
	"results_file_hash" text NOT NULL,
	"analysis_file_hash" text,
	"result_count" integer DEFAULT 0 NOT NULL,
	"verdict_count" integer DEFAULT 0 NOT NULL,
	"orphan_verdict_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_labels" (
	"prompt_id" text NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "prompt_labels_prompt_id_label_pk" PRIMARY KEY("prompt_id","label")
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"prompt_id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"theme" text,
	"branded_type" text,
	"is_relevant" boolean DEFAULT true NOT NULL,
	"location" text,
	"first_seen_run" date NOT NULL,
	"last_seen_run" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_date" date NOT NULL,
	"prompt_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"response_text" text DEFAULT '' NOT NULL,
	"search_tool" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost_usd" double precision,
	"error_code" text,
	"error_message" text,
	"has_error" boolean DEFAULT false NOT NULL,
	"run_branded_type" text,
	"run_theme" text,
	"raw_ref" text
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" serial PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"query" text NOT NULL,
	"ts" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "search_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"snippet" text,
	"score" double precision,
	"page_date" text
);
--> statement-breakpoint
CREATE TABLE "verdict_excerpts" (
	"id" serial PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"excerpt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verdict_owned_urls" (
	"id" serial PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"result_id" text PRIMARY KEY NOT NULL,
	"prompt_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"mentioned" boolean NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"accuracy_score" integer,
	"accuracy_reasoning" text,
	"owned_cited" boolean NOT NULL,
	"others_present" boolean NOT NULL,
	"others_count" integer DEFAULT 0 NOT NULL,
	"brand_rank" text NOT NULL,
	"mention_hypothesis" text,
	"analyzed_at" timestamp with time zone,
	"judge_model" text,
	"judge_input_tokens" integer,
	"judge_output_tokens" integer
);
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_cited_urls" ADD CONSTRAINT "competitor_cited_urls_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_mentions" ADD CONSTRAINT "competitor_mentions_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_aliases" ADD CONSTRAINT "config_aliases_snapshot_id_config_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."config_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_competitors" ADD CONSTRAINT "config_competitors_snapshot_id_config_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."config_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_owned_domains" ADD CONSTRAINT "config_owned_domains_snapshot_id_config_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."config_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_labels" ADD CONSTRAINT "prompt_labels_prompt_id_prompts_prompt_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("prompt_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_prompt_id_prompts_prompt_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("prompt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_excerpts" ADD CONSTRAINT "verdict_excerpts_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_owned_urls" ADD CONSTRAINT "verdict_owned_urls_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_prompt_id_prompts_prompt_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("prompt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "citations_result_id_idx" ON "citations" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "competitor_cited_urls_result_id_idx" ON "competitor_cited_urls" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "competitor_mentions_result_id_idx" ON "competitor_mentions" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "competitor_mentions_name_idx" ON "competitor_mentions" USING btree ("competitor_name");--> statement-breakpoint
CREATE INDEX "results_run_date_provider_idx" ON "results" USING btree ("run_date","provider");--> statement-breakpoint
CREATE INDEX "results_prompt_id_idx" ON "results" USING btree ("prompt_id");--> statement-breakpoint
CREATE INDEX "search_queries_result_id_idx" ON "search_queries" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "search_results_result_id_idx" ON "search_results" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "verdict_excerpts_result_id_idx" ON "verdict_excerpts" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "verdict_owned_urls_result_id_idx" ON "verdict_owned_urls" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "verdicts_prompt_id_idx" ON "verdicts" USING btree ("prompt_id");