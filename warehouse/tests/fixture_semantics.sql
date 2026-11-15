{{ config(enabled=var('manufacturing_fixture_mode')) }}
select 'one_finding_not_two_revisions' as failure where (select count(*) from {{ ref('consumer_findings') }}) <> 1
union all select 'withdrawn_qualification_resurrected' where exists (select 1 from {{ ref('consumer_evidence') }} where evidence_class = 'qualification')
union all select 'older_correction_won' where exists (select 1 from {{ ref('consumer_configuration_conflicts') }})
union all select 'unknown_alias_collapsed' where not exists (select 1 from {{ ref('consumer_genealogy') }} where investigation_from_resolution = 'ambiguous' and investigation_from_hardware_key = '__unknown__')
union all select 'removed_installation_lost' where not exists (select 1 from {{ ref('consumer_genealogy') }} where valid_to = cast('2026-11-05T00:00:00.000Z' as timestamp))
union all select 'future_dimension_leaked_into_original_finding' where not exists (
  select 1 from {{ ref('fact_finding_revision') }} f join {{ ref('sc_dim_hardware') }} h on f.hardware_version_key = h.hardware_version_key
  where f.source_revision = 1 and h.hardware_label = 'SYN-SN008'
)
union all select 'late_dimension_rewrote_original_fact' where not exists (
  select 1 from {{ ref('consumer_genealogy') }} g join {{ ref('dim_source_revision') }} s on g.source_revision_key = s.source_revision_key
  where s.source_native_id = 'SYN-LOT-LINK-011' and g.from_hardware_key = '__unknown__' and g.investigation_from_resolution = 'resolved'
)
union all select 'evidence_claimed_acceptance' where exists (select 1 from {{ ref('consumer_evidence') }} where establishes_acceptance)
