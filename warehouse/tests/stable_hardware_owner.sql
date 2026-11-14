-- Fail the build if two canonical registry objects claim the same enterprise identity.
select dataset_id, {{ jv('payload_json', '$.id') }} as hardware_id
from {{ ref('stg_manufacturing_versions') }} where record_kind = 'hardware' and not is_withdrawn
group by dataset_id, hardware_id having count(distinct source_object_key) > 1
union all
select dataset_id, source_object_key from {{ ref('stg_manufacturing_versions') }}
where record_kind = 'hardware' and not is_withdrawn
group by dataset_id, source_object_key having count(distinct {{ jv('payload_json', '$.id') }}) > 1
