-- Aggregate metadata only; safe for private CI logs. Not an estimate of prompt/API costs.
SELECT json_build_object(
 'databaseBytes',pg_database_size(current_database()),
 'uniqueMessageContents',(SELECT count(*) FROM message_contents),
 'uniqueMessageLogicalBytes',(SELECT coalesce(sum(octet_length(payload::text)),0) FROM message_contents),
 'referencedMessageLogicalBytes',(SELECT coalesce(sum(octet_length(c.payload::text)),0) FROM (SELECT user_id,hash FROM run_messages UNION ALL SELECT user_id,hash FROM conversation_messages) e JOIN message_contents c USING(user_id,hash)),
 'runReferences',(SELECT count(*) FROM run_messages),
 'conversationReferences',(SELECT count(*) FROM conversation_messages),
 'legacyArrayBytes',(SELECT coalesce(sum(octet_length(history::text)),0) FROM conversations)+(SELECT coalesce(sum(octet_length(messages::text)),0) FROM runtime_runs),
 'detailedResearchTraceBytes',(SELECT coalesce(sum(octet_length(data::text)),0) FROM events WHERE type='research.model_input'),
 'oldDetailedTraceRows',(SELECT count(*) FROM events WHERE type='research.model_input' AND created_at<now()-interval '30 days'),
 'uncertainWrites',(SELECT count(*) FROM runtime_calls WHERE state='uncertain')
);
SELECT relname,pg_total_relation_size(relid) AS bytes FROM pg_catalog.pg_statio_user_tables
 WHERE schemaname='public' ORDER BY bytes DESC LIMIT 12;
