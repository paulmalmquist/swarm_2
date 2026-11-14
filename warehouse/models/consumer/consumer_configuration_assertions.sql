select f.*, a.attribute_name, c.known_sequence as investigation_known_sequence,
  coalesce(i.hardware_key, '__unknown__') as investigation_hardware_key,
  coalesce(i.identity_resolution, 'missing') as investigation_identity_resolution
from {{ ref('fact_configuration_assertion') }} f
join {{ ref('consumer_investigation_context') }} c on f.dataset_id = c.dataset_id and {{ active_at('f','c.known_sequence') }}
join {{ ref('dim_configuration_attribute') }} a on f.configuration_attribute_key = a.configuration_attribute_key
left join {{ ref('consumer_identity_as_of') }} i on f.subject_identity_key = i.identity_key
where f.valid_from <= c.physical_at and (f.valid_to is null or c.physical_at < f.valid_to)
