CREATE TABLE public_runs (
  id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL,
  client TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX public_runs_day_client ON public_runs (day, client);
