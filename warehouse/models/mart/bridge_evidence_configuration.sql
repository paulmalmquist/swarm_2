with attributes as (
  {% for name in dimensions() %}
  select source_revision_key as evidence_revision_key,
    {{ sk(["'" ~ name ~ "'"]) }} as configuration_attribute_key,
    {{ jv('payload_json', '$.configuration.' ~ name) }} as recorded_value
  from {{ ref('int_source_version_windows') }}
  where record_kind = 'evidence' and not is_withdrawn and was_current
    and {{ jv('payload_json', '$.configuration.' ~ name) }} is not null
  {% if not loop.last %}union all{% endif %}
  {% endfor %}
)
select {{ sk(['evidence_revision_key','configuration_attribute_key']) }} as evidence_configuration_bridge_key, * from attributes
