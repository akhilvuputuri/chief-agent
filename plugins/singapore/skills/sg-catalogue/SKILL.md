---
name: sg-catalogue
description: The data.gov.sg datasets the Singapore agent may query with sg_dataset, with their fields and query recipes.
---

# Enabled datasets

sg_dataset queries a data.gov.sg CSV dataset by its exact ID:

- `filters` are exact matches, written as field to a list of values;
- `sort` is a field followed by asc or desc;
- `limit` is at most 50.

Every value comes back as a string. Use only the datasets listed here. The full catalogue of other datasets lives in the repository (docs/singapore-open-data-catalogue.md). A dataset is enabled by adding it to this skill in a reviewed change.

## HDB carpark information — d_23f946fa557947f93a8043bbef41dd09

- **Fields:** `car_park_no`, `address`, `x_coord`, `y_coord`, `car_park_type`, `type_of_parking_system`, `short_term_parking`, `free_parking`, `night_parking`, `car_park_decks`, `gantry_height`, `car_park_basement`.
- **Recipe:** filter `free_parking` to `["NO"]` or `night_parking` to `["YES"]` to answer "which carparks…" questions. Use sg_carparks for anything that needs live lots or place names.

## JTC carpark information — d_3b0c377cde41041c93f893d0a92e9fe7

- **Fields:** the same as HDB carpark information.
- **Coverage:** 28 industrial-estate carparks.

## Public holidays — d_8ef23381f9417e4d4254ee8b4dcdb176

- **Fields:** `date`, `day`, `holiday`.
- **Recipe:** prefer sg_holidays.

## Hawker centre closures — d_bda4baa634dd1cc7a6c7cad5f19e2d68

- **Fields:** `name`, `address_myenv`, `q1_cleaningstartdate` to `q4_cleaningenddate`, `other_works_startdate`, `other_works_enddate`, `remarks_*`, `no_of_food_stalls`, `status`.
- **Recipe:** prefer sg_hawker_closures. Use this dataset only for stall counts or status.
