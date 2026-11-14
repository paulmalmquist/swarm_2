select c.dataset_id from {{ ref('consumer_investigation_context') }} c
where c.known_sequence <= 0 or c.known_sequence > (
  select max(d.knowledge_from_sequence) from {{ ref('dim_source_revision') }} d where d.dataset_id = c.dataset_id
)
union all select 'missing_context' where (select count(*) from {{ ref('consumer_investigation_context') }}) <> 1
