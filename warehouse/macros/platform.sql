{% macro str_type() %}{% if target.type == 'bigquery' %}string{% else %}varchar{% endif %}{% endmacro %}
{% macro int_type() %}{% if target.type == 'bigquery' %}int64{% else %}bigint{% endif %}{% endmacro %}
{% macro cast_safe(expr, type) %}
  {% if target.type == 'bigquery' %}safe_cast({{ expr }} as {{ type }}){% else %}try_cast({{ expr }} as {{ type }}){% endif %}
{% endmacro %}
{% macro jv(expr, path) %}
  {% if target.type == 'bigquery' %}json_value({{ expr }}, '{{ path }}'){% else %}json_extract_string({{ expr }}, '{{ path }}'){% endif %}
{% endmacro %}
{% macro jq(expr, path) %}
  {% if target.type == 'bigquery' %}json_query({{ expr }}, '{{ path }}'){% else %}cast(json_extract({{ expr }}, '{{ path }}') as varchar){% endif %}
{% endmacro %}
{% macro text_sha(expr) %}
  {% if target.type == 'bigquery' %}lower(to_hex(sha256({{ expr }}))){% else %}sha256({{ expr }}){% endif %}
{% endmacro %}
{% macro sk(expressions) %}
  {# JSON array encoding distinguishes nulls, empty strings, delimiters and tuple boundaries. #}
  {% if target.type == 'bigquery' %}lower(to_hex(sha256(to_json_string([
  {% else %}sha256(cast(to_json([
  {% endif %}
  {% for expr in expressions %}cast({{ expr }} as {{ str_type() }}){% if not loop.last %}, {% endif %}{% endfor %}
  {% if target.type == 'bigquery' %}])))){% else %}]) as varchar)){% endif %}
{% endmacro %}
{% macro identity_sk(dataset, obj) %}
  {{ sk([dataset, jv(obj, '$.system'), jv(obj, '$.type'), jv(obj, '$.native_id')]) }}
{% endmacro %}
{% macro date_key(expr) %}
  (cast(extract(year from {{ expr }}) as {{ int_type() }}) * 10000 +
   cast(extract(month from {{ expr }}) as {{ int_type() }}) * 100 +
   cast(extract(day from {{ expr }}) as {{ int_type() }}))
{% endmacro %}
{% macro fact_storage() %}
  {% if target.type == 'bigquery' %}
    {{ config(partition_by={'field': 'known_from', 'data_type': 'timestamp', 'granularity': 'day'}, cluster_by=['dataset_id', 'source_object_key']) }}
  {% endif %}
{% endmacro %}
{% macro dimensions() %}{{ return(['design_revision','geometry','material','material_lot','process','supplier','site','equipment','environment','test_procedure','test_setup','instrumentation','firmware']) }}{% endmacro %}
{% macro source_metadata(alias='v') %}
  {{ alias }}.source_revision_key, {{ alias }}.source_object_key, {{ alias }}.source_system_key,
  {{ alias }}.dataset_id, {{ alias }}.data_class, {{ alias }}.source_revision, {{ alias }}.record_hash,
  {{ alias }}.known_from, {{ alias }}.known_to, {{ alias }}.knowledge_from_sequence, {{ alias }}.knowledge_to_sequence,
  {{ alias }}.valid_from, {{ alias }}.valid_to, {{ alias }}.access_tags_json
{% endmacro %}
{% macro active_at(alias, sequence) %}
  {{ alias }}.knowledge_from_sequence <= {{ sequence }}
  and ({{ alias }}.knowledge_to_sequence is null or {{ sequence }} < {{ alias }}.knowledge_to_sequence)
{% endmacro %}
