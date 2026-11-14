with ids as (
  select distinct dataset_id, data_class, {{ jv('payload_json', '$.id') }} as hardware_id
  from {{ ref('int_source_version_windows') }}
  where record_kind = 'hardware' and not is_withdrawn
)
select {{ sk(['dataset_id','hardware_id']) }} as hardware_key, dataset_id, data_class, hardware_id from ids
union all select '__unknown__', '__unknown__', 'unknown', 'Unknown or ambiguous hardware'
