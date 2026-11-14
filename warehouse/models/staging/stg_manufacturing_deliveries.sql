with raw as (
  {% if var('manufacturing_fixture_mode') %}
  select * from {{ ref('raw_manufacturing_versions') }}
  {% else %}
  select * from {{ source('manufacturing_raw', 'source_versions') }}
  {% endif %}
), typed as (
  select dataset_id, data_class, cast(ingestion_sequence as {{ int_type() }}) as ingestion_sequence,
    {{ cast_safe('known_from_text', 'timestamp') }} as known_from,
    record_hash, record_json,
    {{ jv('record_json', '$.source.system') }} as source_system,
    {{ jv('record_json', '$.source.type') }} as source_type,
    {{ jv('record_json', '$.source.native_id') }} as source_native_id,
    {{ cast_safe(jv('record_json', '$.revision'), int_type()) }} as source_revision,
    {{ jv('record_json', '$.kind') }} as record_kind,
    {{ cast_safe(jv('record_json', '$.withdrawn'), 'boolean') }} as is_withdrawn,
    {{ cast_safe(jv('record_json', '$.valid_from'), 'timestamp') }} as valid_from,
    {{ cast_safe(jv('record_json', '$.valid_to'), 'timestamp') }} as valid_to,
    {{ jq('record_json', '$.payload') }} as payload_json,
    {{ jq('record_json', '$.access_tags') }} as access_tags_json
  from raw
)
select *,
  {{ sk(['dataset_id','source_system']) }} as source_system_key,
  {{ sk(['dataset_id','source_system','source_type','source_native_id']) }} as source_object_key,
  {{ sk(['dataset_id','source_system','source_type','source_native_id','source_revision']) }} as source_revision_key
from typed
