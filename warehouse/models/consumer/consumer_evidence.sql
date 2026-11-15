with configuration as (
  select b.evidence_revision_key,
    {% for name in dimensions() %}
    max(case when a.attribute_name = '{{ name }}' then b.recorded_value end) as {{ name }}{% if not loop.last %},{% endif %}
    {% endfor %}
  from {{ ref('bridge_evidence_configuration') }} b
  join {{ ref('dim_configuration_attribute') }} a on b.configuration_attribute_key = a.configuration_attribute_key
  group by b.evidence_revision_key
)
select f.*, cl.evidence_class, c.known_sequence as investigation_known_sequence,
  coalesce(i.hardware_key, '__unknown__') as investigation_hardware_key,
  coalesce(i.identity_resolution, 'missing') as investigation_identity_resolution,
  {% for name in dimensions() %}e.{{ name }},{% endfor %}
  false as establishes_acceptance
from {{ ref('fact_evidence_revision') }} f
join {{ ref('consumer_investigation_context') }} c on f.dataset_id = c.dataset_id and {{ active_at('f','c.known_sequence') }}
join {{ ref('dim_evidence_class') }} cl on f.evidence_class_key = cl.evidence_class_key
left join {{ ref('consumer_identity_as_of') }} i on f.subject_identity_key = i.identity_key
left join configuration e on f.evidence_revision_key = e.evidence_revision_key
