{% for name in ['qualification','acceptance','inspection','process_validation','analysis'] %}
select {{ sk(["'" ~ name ~ "'"]) }} as evidence_class_key, '{{ name }}' as evidence_class
union all
{% endfor %}
select '__unknown__', 'unknown'
