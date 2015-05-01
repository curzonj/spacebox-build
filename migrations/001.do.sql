CREATE TABLE facilities (
    id uuid PRIMARY KEY,
    account uuid not null,
    blueprint uuid not null,
    resourcesLastDeliveredAt timestamp,
    resourceDeliveryStartedAt timestamp,

    trigger_at timestamp,
    next_backoff integer not null default 1,

    status varchar(255),
    next_status varchar(255),
    nextStatusStartedAt timestamp,
    statusCompletedAt timestamp,
    resources json
);

CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    facility_id uuid,
    account uuid not null,

    trigger_at timestamp not null,
    next_backoff integer not null default 1,

    status varchar(255) not null,
    statusCompletedAt timestamp not null,
    next_status varchar(255),
    nextStatusStartedAt timestamp,
    createdAt timestamp not null,
    doc json not null
);
