with refs as (
  {% for role,path in [('subject','$.hardware'),('from','$.from'),('to','$.to')] %}
  select v.source_revision_key, v.dataset_id, v.ingestion_sequence,
    '{{ role }}' as reference_role, {{ identity_sk('v.dataset_id', jq('v.payload_json', path)) }} as identity_key,
    {% if role == 'subject' %}
      case when v.record_kind = 'finding' then {{ cast_safe(jv('v.payload_json', '$.observed_at'), 'timestamp') }} else v.valid_from end
    {% else %}v.valid_from{% endif %} as reference_at
  from {{ ref('int_source_version_windows') }} v
  where not v.is_withdrawn and v.was_current
    {% if role == 'subject' %}and v.record_kind in ('finding','configuration','evidence')
    {% else %}and v.record_kind = 'relationship'{% endif %}
  {% if not loop.last %}union all{% endif %}
  {% endfor %}
)
select r.source_revision_key, r.reference_role, r.identity_key,
  case when count(b.hardware_identity_bridge_key) = 1 then max(b.hardware_key) else '__unknown__' end as hardware_key,
  case when count(b.hardware_identity_bridge_key) = 1 then max(b.hardware_version_key) else '__unknown__' end as hardware_version_key,
  case when count(b.hardware_identity_bridge_key) = 1 then 'resolved' when count(b.hardware_identity_bridge_key) = 0 then 'missing' else 'ambiguous' end as identity_resolution
from refs r left join {{ ref('int_hardware_aliases') }} b
  on r.identity_key = b.identity_key and {{ active_at('b','r.ingestion_sequence') }}
  and b.valid_from <= r.reference_at and (b.valid_to is null or r.reference_at < b.valid_to)
group by r.source_revision_key, r.reference_role, r.identity_key
