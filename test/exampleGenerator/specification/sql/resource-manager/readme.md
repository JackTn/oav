# Sql

> see https://aka.ms/autorest

This is the AutoRest configuration file for Sql.

## Getting Started

To build the SDK for Sql, simply [Install AutoRest](https://aka.ms/autorest/install) and in this folder, run:

> `autorest`

To see additional help and options, run:

> `autorest --help`

## Configuration

### Basic Information

These are the global settings for the Sql API.

``` yaml
title: SqlManagementClient
description: 'The Azure SQL Database management API provides a RESTful set of web services that interact with Azure SQL Database services to manage your databases. The API enables you to create, retrieve, update, and delete databases.'
openapi-type: arm
tag: package-pure-2020-02-preview
```

### Tag: package-pure-2020-02-preview

These settings apply only when `--tag=package-pure-2020-02-preview` is specified on the command line.

This section contains all input swagger files for version 2020-02-02-preview. All APIs of that version must be added this section when the API is ready for production.

APIs must only be added to this section when the API is publicly available in at least 1 production region and at least 1 generated client has been tested end-to-end.

These can be regenerated by running the following PowerShell script from this readme file's folder: `dir .\Microsoft.Sql\preview\2020-02-02-preview\ -File | Resolve-Path -Relative | % { " - $_".Replace("\", "/") }`

``` yaml $(tag) == 'package-pure-2020-02-preview'
input-file:
 - ./Microsoft.Sql/preview/2020-02-02-preview/BackupShortTermRetentionPolicies.json
 - ./Microsoft.Sql/preview/2020-02-02-preview/Databases.json
 - ./Microsoft.Sql/preview/2020-02-02-preview/DatabaseSecurityAlertPolicies.json
 - ./Microsoft.Sql/preview/2020-02-02-preview/ManagedDatabases.json
 - ./Microsoft.Sql/preview/2020-02-02-preview/ManagedInstanceAzureADOnlyAuthentications.json
 - ./Microsoft.Sql/preview/2020-02-02-preview/ManagedServerSecurityAlertPolicies.json
 - ./Microsoft.Sql/preview/2020-02-02-preview/ServerAzureADOnlyAuthentications.json
 - ./Microsoft.Sql/preview/2020-02-02-preview/ServerTrustGroups.json

# Needed when there is more than one input file
override-info:
  title: SqlManagementClient
  ```