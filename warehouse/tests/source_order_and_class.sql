with ordered as (
  select *, lag(known_from) over (partition by dataset_id order by ingestion_sequence) as previous_known_from,
    count(*) over (partition by dataset_id, ingestion_sequence) as sequence_count
  from {{ ref('stg_manufacturing_deliveries') }}
)
select dataset_id from ordered where known_from < previous_known_from or sequence_count > 1
union all
select dataset_id from ordered group by dataset_id having count(distinct data_class) > 1
