select dataset_id,
  case when investigation_identity_resolution = 'resolved' then investigation_hardware_key else subject_identity_key end as configuration_subject_key,
  configuration_scope, configuration_attribute_key,
  attribute_name, investigation_known_sequence, count(distinct asserted_value) as distinct_asserted_values
from {{ ref('consumer_configuration_assertions') }}
group by dataset_id, configuration_subject_key, configuration_scope, configuration_attribute_key, attribute_name, investigation_known_sequence
having count(distinct asserted_value) > 1
