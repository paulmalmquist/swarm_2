{{ fact_storage() }}
select v.source_revision_key as genealogy_bridge_key, {{ source_metadata() }},
  {{ jv('v.payload_json', '$.relationship') }} as relationship_type,
  f.identity_key as from_identity_key, f.hardware_key as from_hardware_key, f.hardware_version_key as from_hardware_version_key, f.identity_resolution as from_identity_resolution,
  t.identity_key as to_identity_key, t.hardware_key as to_hardware_key, t.hardware_version_key as to_hardware_version_key, t.identity_resolution as to_identity_resolution
from {{ ref('int_source_version_windows') }} v
join {{ ref('int_reference_resolution') }} f on v.source_revision_key = f.source_revision_key and f.reference_role = 'from'
join {{ ref('int_reference_resolution') }} t on v.source_revision_key = t.source_revision_key and t.reference_role = 'to'
where v.record_kind = 'relationship' and not v.is_withdrawn and v.was_current
