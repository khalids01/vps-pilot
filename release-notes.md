# VPS Pilot 0.2.8

- Add Docker → Databases for PostgreSQL, MySQL, MariaDB and MongoDB: choose a running container, supply transient credentials and list databases.
- Review and download an individual logical backup directly to a local file using pg_dump, mysqldump/mariadb-dump or mongodump, with streamed progress, cancellation and a SHA-256 receipt.
- Protect existing local files from overwrite, clean incomplete staging files and reject changed SSH/container identities. Credentials and backup contents are excluded from app history.

Requires Python 3 and Docker access on the VPS and native database client/dump tools inside the container. Uses standard loopback database ports; no ports are exposed. Limits: 100 GiB / one hour. Restoration and cluster-wide roles/users are not included; test restoration with compatible tool versions before relying on a backup.
