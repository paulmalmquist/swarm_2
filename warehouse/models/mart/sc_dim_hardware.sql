select * from {{ ref('int_hardware_history') }}
union all select '__unknown__', '__unknown__',
  cast(null as {{ str_type() }}), cast(null as {{ str_type() }}), '__unknown__', '__unknown__', 'unknown',
  cast(null as {{ int_type() }}), cast(null as {{ str_type() }}),
  cast(null as timestamp), cast(null as timestamp), cast(null as {{ int_type() }}), cast(null as {{ int_type() }}),
  cast(null as timestamp), cast(null as timestamp), '[]', 'Unknown', 'Unknown or ambiguous', 'unknown', 'unverified', false
