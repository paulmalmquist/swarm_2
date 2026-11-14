{% for model,kind in [('fact_finding_revision','finding'),('fact_evidence_revision','evidence'),('fact_configuration_assertion','configuration'),('bridge_hardware_genealogy','relationship')] %}
select '{{ model }}' as model_name
where (select count(*) from {{ ref(model) }}) <>
  (select count(*) from {{ ref('dim_source_revision') }} where record_kind = '{{ kind }}' and was_current and not is_withdrawn)
{% if not loop.last %}union all{% endif %}
{% endfor %}
