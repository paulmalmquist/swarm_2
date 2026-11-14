with records as (
  select * from {{ ref('stg_manufacturing_versions') }} where not is_withdrawn
)
select source_revision_key from records
where (record_kind = 'hardware' and (
    {{ jv('payload_json', '$.id') }} is null or {{ jv('payload_json', '$.label') }} is null
    or coalesce({{ jv('payload_json', '$.hardware_kind') }}, '') not in ('part_definition','serial','lot','assembly','article')
    or coalesce({{ jv('payload_json', '$.genealogy_status') }}, '') not in ('declared_complete','incomplete','unverified')))
  or (record_kind in ('finding','evidence','configuration') and (
    {{ jv('payload_json', '$.hardware.system') }} is null or {{ jv('payload_json', '$.hardware.type') }} is null or {{ jv('payload_json', '$.hardware.native_id') }} is null))
  or (record_kind = 'relationship' and (
    {{ jv('payload_json', '$.from.system') }} is null or {{ jv('payload_json', '$.from.type') }} is null or {{ jv('payload_json', '$.from.native_id') }} is null
    or {{ jv('payload_json', '$.to.system') }} is null or {{ jv('payload_json', '$.to.type') }} is null or {{ jv('payload_json', '$.to.native_id') }} is null
    or coalesce({{ jv('payload_json', '$.relationship') }}, '') not in ('produced_from','installed_in','split_from','merged_from')))
  or (record_kind = 'configuration' and (
    coalesce({{ jv('payload_json', '$.scope') }}, '') not in ('designed','planned','built','installed','tested')
    or {{ jv('payload_json', '$.value') }} is null))
