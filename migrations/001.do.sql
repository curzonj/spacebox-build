CREATE TABLE facilities (
    id uuid PRIMARY KEY,
    account uuid not null,
    blueprint uuid not null,
    resourcesLastDeliveredAt timestamp,
    resourceDeliveryStartedAt timestamp,

--   status varchar(255) not null,
--   next_status varchar(255) not null,
--   nextStatusStartedAt timestamp,
--   statusCompletedAt timestamp,
   resources json
);

CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    facility_id uuid,
    account uuid not null,

    status varchar(255) not null,
    statusCompletedAt timestamp not null,
    next_status varchar(255),
    nextStatusStartedAt timestamp,
    createdAt timestamp not null,
    doc json not null
);
