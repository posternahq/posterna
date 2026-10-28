<?php
/**
 * The hourly counters table.
 *
 * @package Posterna
 */

namespace Posterna;

defined( 'ABSPATH' ) || exit;

/**
 * One row per hour, kind (page or signup), verdict, reason, operator,
 * agent, purpose and path group, with a count. No addresses, URLs, headers,
 * user names or anything else about a single request is stored. Rows older
 * than 90 days are removed daily.
 *
 * Direct queries are needed: this is the plugin's own table, and the counts
 * change on every request, so there is nothing for the object cache to keep.
 *
 * phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
 */
final class Counter_Table {

	const DB_VERSION        = '1';
	const DB_VERSION_OPTION = 'posterna_db_version';
	const RETENTION_DAYS    = 90;

	/**
	 * The table name.
	 *
	 * @return string
	 */
	public static function name() {
		global $wpdb;
		return $wpdb->prefix . 'posterna_counts';
	}

	/**
	 * Creates or updates the table.
	 */
	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::name();
		$charset = $wpdb->get_charset_collate();
		dbDelta(
			"CREATE TABLE {$table} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  bucket char(40) NOT NULL,
  hour_start datetime NOT NULL,
  kind varchar(10) NOT NULL DEFAULT 'page',
  verdict varchar(32) NOT NULL,
  reason varchar(40) NOT NULL DEFAULT '',
  operator varchar(100) NOT NULL DEFAULT '',
  agent varchar(200) NOT NULL DEFAULT '',
  purpose varchar(20) NOT NULL DEFAULT '',
  path_group varchar(200) NOT NULL DEFAULT '',
  hits int(10) unsigned NOT NULL DEFAULT 0,
  internal int(10) unsigned NOT NULL DEFAULT 0,
  sent int(10) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (id),
  UNIQUE KEY bucket (bucket),
  KEY hour_start (hour_start)
) {$charset};"
		);
		update_option( self::DB_VERSION_OPTION, self::DB_VERSION, true );
	}

	/**
	 * True when the table exists at the current version.
	 *
	 * @return bool
	 */
	public static function is_current() {
		return self::DB_VERSION === get_option( self::DB_VERSION_OPTION );
	}

	/**
	 * Removes the table (uninstall only).
	 */
	public static function drop() {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.SchemaChange -- Uninstall removes the plugin's own table.
		$wpdb->query( $wpdb->prepare( 'DROP TABLE IF EXISTS %i', self::name() ) );
		delete_option( self::DB_VERSION_OPTION );
	}

	/**
	 * Counts one request or sign-up.
	 *
	 * @param string $kind       'page' or 'signup'.
	 * @param array  $result     Verdict result.
	 * @param string $path_group Path group.
	 * @param bool   $internal   True when the client address was internal.
	 * @param int    $now        Unix time.
	 */
	public static function record( $kind, $result, $path_group, $internal, $now ) {
		global $wpdb;
		$hour   = gmdate( 'Y-m-d H:00:00', $now );
		$fields = array(
			$kind,
			(string) $result['verdict'],
			isset( $result['reason'] ) ? (string) $result['reason'] : '',
			isset( $result['operator'] ) ? substr( (string) $result['operator'], 0, 100 ) : '',
			isset( $result['agent'] ) ? substr( (string) $result['agent'], 0, 200 ) : '',
			isset( $result['purpose'] ) ? (string) $result['purpose'] : '',
			substr( (string) $path_group, 0, 200 ),
		);
		$bucket = sha1( $hour . "\0" . implode( "\0", $fields ) );
		$flag   = $internal ? 1 : 0;
		$wpdb->query(
			$wpdb->prepare(
				'INSERT INTO %i (bucket, hour_start, kind, verdict, reason, operator, agent, purpose, path_group, hits, internal) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 1, %d) ON DUPLICATE KEY UPDATE hits = hits + 1, internal = internal + %d',
				self::name(),
				$bucket,
				$hour,
				$fields[0],
				$fields[1],
				$fields[2],
				$fields[3],
				$fields[4],
				$fields[5],
				$fields[6],
				$flag,
				$flag
			)
		);
	}

	/**
	 * Removes rows older than the retention window.
	 *
	 * @param int $now Unix time.
	 */
	public static function prune( $now ) {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( 'DELETE FROM %i WHERE hour_start < %s', self::name(), gmdate( 'Y-m-d H:00:00', $now - self::RETENTION_DAYS * DAY_IN_SECONDS ) ) );
	}

	/**
	 * Counts by verdict since a time.
	 *
	 * @param string $kind  'page' or 'signup'.
	 * @param int    $since Unix time.
	 * @return array Verdict => count.
	 */
	public static function totals( $kind, $since ) {
		global $wpdb;
		$rows   = $wpdb->get_results( $wpdb->prepare( 'SELECT verdict, SUM(hits) AS total FROM %i WHERE kind = %s AND hour_start >= %s GROUP BY verdict', self::name(), $kind, gmdate( 'Y-m-d H:00:00', $since ) ), ARRAY_A );
		$totals = array();
		foreach ( (array) $rows as $row ) {
			$totals[ $row['verdict'] ] = (int) $row['total'];
		}
		return $totals;
	}

	/**
	 * Counts by operator, agent, purpose and verdict since a time.
	 *
	 * @param int $since Unix time.
	 * @param int $limit Most rows.
	 * @return array
	 */
	public static function by_agent( $since, $limit = 200 ) {
		global $wpdb;
		return (array) $wpdb->get_results(
			$wpdb->prepare(
				"SELECT operator, agent, purpose, verdict, SUM(hits) AS total FROM %i WHERE kind = 'page' AND operator <> '' AND hour_start >= %s GROUP BY operator, agent, purpose, verdict ORDER BY total DESC LIMIT %d",
				self::name(),
				gmdate( 'Y-m-d H:00:00', $since ),
				$limit
			),
			ARRAY_A
		);
	}

	/**
	 * Counts by path group and verdict since a time.
	 *
	 * @param int $since Unix time.
	 * @return array
	 */
	public static function by_path( $since ) {
		global $wpdb;
		return (array) $wpdb->get_results(
			$wpdb->prepare(
				"SELECT path_group, verdict, SUM(hits) AS total FROM %i WHERE kind = 'page' AND hour_start >= %s GROUP BY path_group, verdict",
				self::name(),
				gmdate( 'Y-m-d H:00:00', $since )
			),
			ARRAY_A
		);
	}

	/**
	 * Operators whose first counted request is after a time.
	 *
	 * @param int $since Unix time.
	 * @return array List of array( operator, first_seen, total ).
	 */
	public static function new_operators( $since ) {
		global $wpdb;
		return (array) $wpdb->get_results(
			$wpdb->prepare(
				"SELECT operator, MIN(hour_start) AS first_seen, SUM(hits) AS total FROM %i WHERE kind = 'page' AND operator <> '' GROUP BY operator HAVING MIN(hour_start) >= %s ORDER BY first_seen DESC",
				self::name(),
				gmdate( 'Y-m-d H:00:00', $since )
			),
			ARRAY_A
		);
	}

	/**
	 * Requests and internal addresses since a time, for the proxy check.
	 *
	 * @param int $since Unix time.
	 * @return array array( 'hits' => int, 'internal' => int ).
	 */
	public static function address_mix( $since ) {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT SUM(hits) AS hits, SUM(internal) AS internal FROM %i WHERE kind = 'page' AND hour_start >= %s", self::name(), gmdate( 'Y-m-d H:00:00', $since ) ), ARRAY_A );
		return array(
			'hits'     => isset( $row['hits'] ) ? (int) $row['hits'] : 0,
			'internal' => isset( $row['internal'] ) ? (int) $row['internal'] : 0,
		);
	}

	/**
	 * Fail-open results since a time, for the errors count sent with counters.
	 *
	 * @param int $since Unix time.
	 * @return int
	 */
	public static function fail_open_count( $since ) {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT SUM(hits) FROM %i WHERE kind = 'page' AND hour_start >= %s AND reason IN ('directory_unavailable', 'clock_invalid', 'rdns_error', 'library_unsupported', 'library_error', 'unexpected_error')",
				self::name(),
				gmdate( 'Y-m-d H:00:00', $since )
			)
		);
	}

	/**
	 * Page rows with counts not yet sent to posterna.com.
	 *
	 * @param int $since Unix time; older rows are never sent.
	 * @param int $limit Most rows.
	 * @return array
	 */
	public static function unsent( $since, $limit ) {
		global $wpdb;
		return (array) $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, hour_start, verdict, reason, operator, agent, purpose, path_group, hits, sent FROM %i WHERE kind = 'page' AND hits > sent AND hour_start >= %s ORDER BY hour_start ASC LIMIT %d",
				self::name(),
				gmdate( 'Y-m-d H:00:00', $since ),
				$limit
			),
			ARRAY_A
		);
	}

	/**
	 * Marks counts as sent.
	 *
	 * @param array $deltas Row id => count sent.
	 */
	public static function mark_sent( $deltas ) {
		global $wpdb;
		foreach ( $deltas as $id => $delta ) {
			$wpdb->query( $wpdb->prepare( 'UPDATE %i SET sent = sent + %d WHERE id = %d', self::name(), $delta, $id ) );
		}
	}
}
