CREATE EXTENSION "uuid-ossp";

CREATE TABLE facilities (
    id uuid PRIMARY KEY,
    account uuid not null,
    blueprint uuid not null,
    resourcesLastDeliveredAt timestamp with time zone,
    resourceDeliveryStartedAt timestamp with time zone,

    trigger_at timestamp with time zone,
    next_backoff interval not null default '1 second',

    status varchar(255),
    next_status varchar(255),
    nextStatusStartedAt timestamp with time zone,
    statusCompletedAt timestamp with time zone,
    resources json
);

CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    facility_id uuid,
    account uuid not null,

    trigger_at timestamp with time zone not null,
    next_backoff interval not null default '1 second',

    status varchar(255) not null,
    statusCompletedAt timestamp with time zone not null,
    next_status varchar(255),
    nextStatusStartedAt timestamp with time zone,
    createdAt timestamp with time zone not null,
    doc json not null
);
