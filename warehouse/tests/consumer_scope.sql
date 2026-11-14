{% for model in ['consumer_findings','consumer_evidence','consumer_genealogy','consumer_configuration_assertions','consumer_hardware_as_of'] %}
select '{{ model }}' as model_name, dataset_id from {{ ref(model) }}
where dataset_id <> '{{ (var("consumer_dataset_id") or "").replace("'", "''") }}'
{% if not loop.last %}union all{% endif %}
{% endfor %}
