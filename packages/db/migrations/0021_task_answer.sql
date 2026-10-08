-- The AI employee's answer to the person who gave the work, in full; the outcome stays one sentence for lists.
ALTER TABLE "tasks" ADD COLUMN "answer" text;