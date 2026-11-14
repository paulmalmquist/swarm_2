with dates as (
  {% if target.type == 'bigquery' %}
    select full_date from unnest(generate_date_array(date('{{ var("date_start") }}'), date('{{ var("date_end") }}'))) full_date
  {% else %}
    select cast(day as date) as full_date from generate_series(date '{{ var("date_start") }}', date '{{ var("date_end") }}', interval '1 day') as d(day)
  {% endif %}
)
select {{ date_key('full_date') }} as date_key, full_date,
  extract(year from full_date) as calendar_year, extract(month from full_date) as calendar_month,
  extract(day from full_date) as day_of_month
from dates
union all select 0, cast(null as date), cast(null as {{ int_type() }}), cast(null as {{ int_type() }}), cast(null as {{ int_type() }})
