{% for name in dimensions() %}
select {{ sk(["'" ~ name ~ "'"]) }} as configuration_attribute_key, '{{ name }}' as attribute_name
union all
{% endfor %}
select '__unknown__', 'unknown'
