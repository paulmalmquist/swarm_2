with ordered as (
  select *, max(source_revision) over (
    partition by source_object_key order by ingestion_sequence
    rows between unbounded preceding and 1 preceding
  ) as previous_max_revision
  from {{ ref('stg_manufacturing_versions') }}
), accepted as (
  select *,
    lead(known_from) over (partition by source_object_key order by ingestion_sequence) as known_to,
    lead(ingestion_sequence) over (partition by source_object_key order by ingestion_sequence) as knowledge_to_sequence
  from ordered where previous_max_revision is null or source_revision > previous_max_revision
)
select v.*, v.ingestion_sequence as knowledge_from_sequence,
  case when a.source_revision_key is null then v.known_from else a.known_to end as known_to,
  case when a.source_revision_key is null then v.ingestion_sequence else a.knowledge_to_sequence end as knowledge_to_sequence,
  a.source_revision_key is not null as was_current,
  a.source_revision_key is not null and a.knowledge_to_sequence is null as is_current
from ordered v left join accepted a on v.source_revision_key = a.source_revision_key
