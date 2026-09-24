CREATE INDEX "knowledge_chunks_company_model" ON "knowledge_chunks" USING btree ("company_id","embedding_model");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_company_collection" ON "knowledge_chunks" USING btree ("company_id","collection_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_collection_hash" ON "knowledge_documents" USING btree ("collection_id","content_hash");--> statement-breakpoint
CREATE INDEX "knowledge_documents_company_created" ON "knowledge_documents" USING btree ("company_id","created_at");