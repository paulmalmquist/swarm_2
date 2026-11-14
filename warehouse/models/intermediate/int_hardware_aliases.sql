with primary_identities as (
  select h.hardware_version_key, h.hardware_key, h.dataset_id, h.source_object_key as identity_key,
    h.knowledge_from_sequence, h.knowledge_to_sequence, h.valid_from, h.valid_to
  from {{ ref('int_hardware_history') }} h where h.hardware_version_key <> '__unknown__'
), aliases as (
  select h.hardware_version_key, h.hardware_key, h.dataset_id,
    {{ identity_sk('h.dataset_id', 'alias_json') }} as identity_key,
    h.knowledge_from_sequence, h.knowledge_to_sequence, h.valid_from, h.valid_to
  from {{ ref('int_hardware_history') }} h
  join {{ ref('int_source_version_windows') }} v on h.source_revision_key = v.source_revision_key
  {% if target.type == 'bigquery' %}
  cross join unnest(json_query_array(v.payload_json, '$.aliases')) as alias_json
  {% else %}
  cross join unnest(cast(json_extract(v.payload_json, '$.aliases') as json[])) as items(alias_json)
  {% endif %}
), combined as (
  select * from primary_identities union distinct select * from aliases
)
select {{ sk(['hardware_version_key','identity_key']) }} as hardware_identity_bridge_key, * from combined
