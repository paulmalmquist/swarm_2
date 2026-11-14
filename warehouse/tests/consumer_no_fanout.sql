{% for model,key in [('consumer_findings','source_object_key'),('consumer_evidence','source_object_key'),('consumer_genealogy','source_object_key'),('consumer_configuration_assertions','source_object_key')] %}
select '{{ model }}' as model_name, {{ key }} as duplicated_key from {{ ref(model) }}
group by {{ key }} having count(*) <> 1
{% if not loop.last %}union all{% endif %}
{% endfor %}
