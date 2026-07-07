<#
.SYNOPSIS
Exports an existing Check extension GPO's configuration as JSON that the
CheckDeployManager tenant onboarding wizard can adopt.

.DESCRIPTION
For operators already deploying the Check browser extension through a Group
Policy Object built with Check's official ADMX templates (or the .reg
layout). Run on a domain controller or management host with the Group
Policy PowerShell module (RSAT). The script asks for the GPO's name, reads
the Check policy values from the Chrome hive (falling back to Edge), and
prints managed-storage-shaped JSON, also saved next to the script.

Paste the JSON into the tenant onboarding wizard's "Migrating from the
official Check GPO?" panel; branding and policy values are adopted into the
tenant. The customRulesUrl is included for reference but ignored on import,
because the tenant's own config URL replaces it.

Read-only: this script never modifies the GPO.

.EXAMPLE
.\Export-CheckGpoConfig.ps1
Prompts for the GPO name and writes check-gpo-export.json.
#>
[CmdletBinding()]
param(
    # Skip the prompt by passing the GPO name directly.
    [string]$GroupPolicyName = ""
)

$ErrorActionPreference = 'Stop'
Import-Module GroupPolicy

$chromeExtensionId = 'benimdeioplgkhanklclahllklceahbe'
$edgeExtensionId = 'knepjpocdagponkonnbggpcnhnaikajg'

if ($GroupPolicyName -eq '') {
    $GroupPolicyName = Read-Host 'Name of the GPO that currently carries the Check extension policy'
}
if ($GroupPolicyName.Trim() -eq '') {
    Write-Error 'A GPO name is required.'
}

# Returns a hashtable of ValueName -> Value for one registry key inside the
# GPO, or $null when the key does not exist there.
function Get-GpoKeyValues {
    param(
        [string]$PolicyName,
        [string]$Key
    )
    try {
        $entries = Get-GPRegistryValue -Name $PolicyName -Key $Key -ErrorAction Stop
    } catch {
        return $null
    }
    $values = @{}
    foreach ($entry in $entries) {
        if ($null -ne $entry.PSObject.Properties['ValueName'] -and $null -ne $entry.ValueName) {
            $values[$entry.ValueName] = $entry.Value
        }
    }
    return $values
}

# Numbered-value subkeys (urlAllowlist, webhook events) become ordered arrays.
function Get-GpoNumberedList {
    param(
        [string]$PolicyName,
        [string]$Key
    )
    $values = Get-GpoKeyValues -PolicyName $PolicyName -Key $Key
    if ($null -eq $values) { return @() }
    $ordered = @()
    foreach ($name in ($values.Keys | Sort-Object { [int]$_ })) {
        $ordered += [string]$values[$name]
    }
    return $ordered
}

function ConvertTo-BooleanValue {
    param($Value, [bool]$Default)
    if ($null -eq $Value) { return $Default }
    return ([int]$Value) -ne 0
}

# Locate the policy root: Chrome hive first, then Edge. Both carry the same
# values when generated from Check's enterprise templates.
$candidates = @(
    @{ Browser = 'Chrome'; Root = "HKLM\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\$chromeExtensionId\policy" },
    @{ Browser = 'Edge'; Root = "HKLM\SOFTWARE\Policies\Microsoft\Edge\3rdparty\extensions\$edgeExtensionId\policy" }
)
$root = $null
$rootValues = $null
foreach ($candidate in $candidates) {
    $rootValues = Get-GpoKeyValues -PolicyName $GroupPolicyName -Key $candidate.Root
    if ($null -ne $rootValues) {
        $root = $candidate
        break
    }
}
if ($null -eq $root) {
    Write-Error ("No Check policy values found in GPO '$GroupPolicyName'. Looked under the Chrome and Edge " +
        '3rdparty extension policy keys; confirm the GPO name and that it carries the Check ADMX or .reg values.')
}
Write-Output "Reading Check policy from the $($root.Browser) hive of GPO '$GroupPolicyName'."

$export = [ordered]@{
    customRulesUrl = [string]$rootValues['customRulesUrl']
    updateInterval = if ($null -ne $rootValues['updateInterval']) { [int]$rootValues['updateInterval'] } else { 24 }
    enablePageBlocking = ConvertTo-BooleanValue -Value $rootValues['enablePageBlocking'] -Default $true
    showNotifications = ConvertTo-BooleanValue -Value $rootValues['showNotifications'] -Default $true
    enableValidPageBadge = ConvertTo-BooleanValue -Value $rootValues['enableValidPageBadge'] -Default $true
    validPageBadgeTimeout = if ($null -ne $rootValues['validPageBadgeTimeout']) { [int]$rootValues['validPageBadgeTimeout'] } else { 5 }
    enableDebugLogging = ConvertTo-BooleanValue -Value $rootValues['enableDebugLogging'] -Default $false
    enableCippReporting = ConvertTo-BooleanValue -Value $rootValues['enableCippReporting'] -Default $false
    urlAllowlist = Get-GpoNumberedList -PolicyName $GroupPolicyName -Key "$($root.Root)\urlAllowlist"
}
if ($null -ne $rootValues['cippServerUrl']) { $export['cippServerUrl'] = [string]$rootValues['cippServerUrl'] }
if ($null -ne $rootValues['cippTenantId']) { $export['cippTenantId'] = [string]$rootValues['cippTenantId'] }

$webhookValues = Get-GpoKeyValues -PolicyName $GroupPolicyName -Key "$($root.Root)\genericWebhook"
if ($null -ne $webhookValues) {
    $export['genericWebhook'] = [ordered]@{
        enabled = ConvertTo-BooleanValue -Value $webhookValues['enabled'] -Default $true
        events = Get-GpoNumberedList -PolicyName $GroupPolicyName -Key "$($root.Root)\genericWebhook\events"
    }
}

$squattingValues = Get-GpoKeyValues -PolicyName $GroupPolicyName -Key "$($root.Root)\domainSquatting"
if ($null -ne $squattingValues) {
    $squatting = [ordered]@{
        enabled = ConvertTo-BooleanValue -Value $squattingValues['enabled'] -Default $true
    }
    if ($null -ne $squattingValues['deviationThreshold']) { $squatting['deviationThreshold'] = [int]$squattingValues['deviationThreshold'] }
    if ($null -ne $squattingValues['Action']) { $squatting['Action'] = [string]$squattingValues['Action'] }
    $export['domainSquatting'] = $squatting
}

$brandingValues = Get-GpoKeyValues -PolicyName $GroupPolicyName -Key "$($root.Root)\customBranding"
if ($null -ne $brandingValues) {
    $branding = [ordered]@{}
    foreach ($field in @('companyName', 'productName', 'supportEmail', 'supportUrl', 'privacyPolicyUrl', 'aboutUrl', 'primaryColor')) {
        if ($null -ne $brandingValues[$field] -and [string]$brandingValues[$field] -ne '') {
            $branding[$field] = [string]$brandingValues[$field]
        }
    }
    if ($branding.Count -gt 0) { $export['customBranding'] = $branding }
}

$json = $export | ConvertTo-Json -Depth 6
$outputPath = Join-Path -Path (Get-Location) -ChildPath 'check-gpo-export.json'
Set-Content -Path $outputPath -Value $json -Encoding Ascii

Write-Output ''
Write-Output $json
Write-Output ''
Write-Output "Saved to $outputPath."
Write-Output 'Paste the JSON above into the tenant onboarding wizard: Tenants > Onboard wizard >'
Write-Output '"Migrating from the official Check GPO?" panel > Adopt config.'
Write-Output 'The customRulesUrl is shown for reference only; the tenant gets its own config URL.'
