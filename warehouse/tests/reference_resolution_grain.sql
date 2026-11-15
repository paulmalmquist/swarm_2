select source_revision_key, reference_role from {{ ref('int_reference_resolution') }}
group by source_revision_key, reference_role having count(*) <> 1
