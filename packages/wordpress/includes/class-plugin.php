<?php
/**
 * Wires the verifier into WordPress.
 *
 * @package Posterna
 */

namespace Posterna;

use Posterna\Directory\Directory_Store;
use Posterna\Verifier\Address;
use Posterna\Verifier\Path_Group;
use Posterna\Verifier\Rdns_Cache;
use Posterna\Verifier\Request;
use Posterna\Verifier\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * The plugin. Version 1.0 runs in monitor mode only: it labels and counts
 * requests and never blocks, throttles or challenges anything.
 */
final class Plugin {

	const SETTINGS_OPTION = 'posterna_settings';
	const STATE_OPTION    = 'posterna_state';
	const GROUPS_OPTION   = 'posterna_path_groups';
	const VERSION_OPTION  = 'posterna_version';
	const BASE_URL        = 'https://posterna.com/v1/';
	const MAX_PATH_GROUPS = 50;
	const SEND_BATCH      = 500;

	const CRON_DAILY        = 'posterna_daily';
	const CRON_HOURLY       = 'posterna_hourly';
	const CRON_SEND         = 'posterna_send_counts';
	const CRON_REFRESH_NOW  = 'posterna_refresh_now';
	const CRON_REFRESH_KEYS = 'posterna_refresh_keys';
	const SEND_SCHEDULE     = 'posterna_five_minutes';

	/**
	 * The one instance.
	 *
	 * @var Plugin|null
	 */
	private static $instance = null;

	/**
	 * Inbound X-Agent-* and X-Posterna-* headers removed from $_SERVER.
	 *
	 * @var array
	 */
	private $stripped = array();

	/**
	 * The verdict for this request, once checked.
	 *
	 * @var array|null
	 */
	private $verdict = null;

	/**
	 * The client address for this request was internal.
	 *
	 * @var bool
	 */
	private $internal = false;

	/**
	 * Time the check took, in nanoseconds.
	 *
	 * @var int
	 */
	private $elapsed_ns = 0;

	/**
	 * Whether the posterna_verdict action has fired.
	 *
	 * @var bool
	 */
	private $announced = false;

	/**
	 * The directory store, once created.
	 *
	 * @var Directory_Store|null
	 */
	private $store = null;

	/**
	 * The verifier, once created.
	 *
	 * @var Verifier|null
	 */
	private $verifier = null;

	/**
	 * The plugin.
	 *
	 * @return Plugin
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Removes every inbound X-Agent-* and X-Posterna-* header from a $_SERVER
	 * array, so no client can forge a verdict (docs/SPEC.md section 4.7).
	 *
	 * @param array $server $_SERVER, by reference.
	 * @return array Lowercase header names removed, sorted.
	 */
	public static function strip_inbound_headers( &$server ) {
		$removed = array();
		foreach ( array_keys( $server ) as $key ) {
			if ( is_string( $key ) && ( 0 === strpos( $key, 'HTTP_X_AGENT_' ) || 0 === strpos( $key, 'HTTP_X_POSTERNA_' ) ) ) {
				$removed[ strtolower( str_replace( '_', '-', substr( $key, 5 ) ) ) ] = true;
				unset( $server[ $key ] );
			}
		}
		$names = array_keys( $removed );
		sort( $names );
		return $names;
	}

	/**
	 * Starts the plugin: strips inbound verdict headers and adds the hooks.
	 */
	public static function boot() {
		$plugin           = self::instance();
		$plugin->stripped = self::strip_inbound_headers( $_SERVER );

		add_action( 'plugins_loaded', array( $plugin, 'on_plugins_loaded' ), 1 );
		add_action( 'init', array( $plugin, 'announce' ), 1 );
		add_action( 'shutdown', array( $plugin, 'count_request' ) );
		add_filter( 'cron_schedules', array( __CLASS__, 'cron_schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval -- Five minutes, only while a site key is set.
		add_action( self::CRON_DAILY, array( $plugin, 'run_daily' ) );
		add_action( self::CRON_HOURLY, array( $plugin, 'run_hourly' ) );
		add_action( self::CRON_SEND, array( $plugin, 'send_counts' ) );
		add_action( self::CRON_REFRESH_NOW, array( $plugin, 'refresh_now' ) );
		add_action( self::CRON_REFRESH_KEYS, array( $plugin, 'refresh_keys' ) );
		add_action( Transient_Rdns_Store::CRON_HOOK, array( $plugin, 'run_rdns' ) );
		add_action( 'register_new_user', array( $plugin, 'count_signup' ) );
		add_action( 'woocommerce_created_customer', array( $plugin, 'count_signup' ) );
		if ( is_admin() ) {
			Admin::register();
		}
		add_action( 'wp_dashboard_setup', array( Admin::class, 'add_dashboard_widget' ) );
	}

	/**
	 * Adds the five-minute schedule used to send counters.
	 *
	 * @param array $schedules Schedules.
	 * @return array
	 */
	public static function cron_schedules( $schedules ) {
		$schedules[ self::SEND_SCHEDULE ] = array(
			'interval' => 5 * MINUTE_IN_SECONDS,
			'display'  => 'Every five minutes (Posterna)',
		);
		return $schedules;
	}

	/**
	 * Settings with defaults.
	 *
	 * @return array
	 */
	public static function settings() {
		$defaults = array(
			'client_ip'        => 'remote_addr',
			'client_ip_header' => '',
			'trusted_proxies'  => array(),
			'hops'             => 1,
			'template'         => 'monitor',
			'updates'          => false,
			'site_key'         => '',
			'setup_done'       => false,
		);
		$saved    = get_option( self::SETTINGS_OPTION, array() );
		return array_merge( $defaults, is_array( $saved ) ? $saved : array() );
	}

	/**
	 * Runtime state (refresh results, send results, cron runs).
	 *
	 * @return array
	 */
	public static function state() {
		$state = get_option( self::STATE_OPTION, array() );
		return is_array( $state ) ? $state : array();
	}

	/**
	 * Merges values into the runtime state.
	 *
	 * @param array $values Values.
	 */
	public static function update_state( $values ) {
		update_option( self::STATE_OPTION, array_merge( self::state(), $values ), false );
	}

	/**
	 * The base URL for posterna.com, which a site may point elsewhere only with
	 * the POSTERNA_BASE_URL constant in wp-config.php (for testing).
	 *
	 * @return string
	 */
	public static function base_url() {
		return ( defined( 'POSTERNA_BASE_URL' ) && is_string( POSTERNA_BASE_URL ) ) ? trailingslashit( POSTERNA_BASE_URL ) : self::BASE_URL;
	}

	/**
	 * Proxy options for the verifier, from the settings.
	 *
	 * @param array $settings Settings.
	 * @return array
	 */
	public static function proxy_options( $settings ) {
		$options = array();
		if ( 'header' === $settings['client_ip'] && '' !== $settings['client_ip_header'] ) {
			$options['clientIpHeader'] = $settings['client_ip_header'];
			if ( array() !== $settings['trusted_proxies'] ) {
				$options['trustedProxies'] = array_values( $settings['trusted_proxies'] );
			}
		} elseif ( 'hops' === $settings['client_ip'] ) {
			$options['trustedProxies'] = max( 1, (int) $settings['hops'] );
		}
		$hosts = array();
		foreach ( array( home_url(), site_url() ) as $url ) {
			$host = wp_parse_url( $url, PHP_URL_HOST );
			$port = wp_parse_url( $url, PHP_URL_PORT );
			if ( is_string( $host ) && '' !== $host ) {
				$hosts[] = strtolower( $host ) . ( $port ? ':' . $port : '' );
			}
		}
		if ( array() !== $hosts ) {
			$options['publicHost'] = array_values( array_unique( $hosts ) );
		}
		return $options;
	}

	/**
	 * The bundled snapshot of directory.json and keys.json.
	 *
	 * @return array
	 * @throws \RuntimeException When it is missing or unreadable.
	 */
	public static function snapshot() {
		$files = array();
		foreach ( array( 'directory', 'keys' ) as $name ) {
			$path = POSTERNA_DIR . '/data/' . $name . '.json';
			// Reading a bundled data file from the plugin folder, not a remote URL.
			$text = is_readable( $path ) ? file_get_contents( $path ) : false; // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			if ( false === $text ) {
				$exception = new \RuntimeException( 'the bundled ' . $name . '.json is missing' );
				throw $exception;
			}
			$value = json_decode( $text, true );
			if ( ! is_array( $value ) ) {
				$exception = new \RuntimeException( 'the bundled ' . $name . '.json is not valid JSON' );
				throw $exception;
			}
			$files[ $name ] = $value;
		}
		return $files;
	}

	/**
	 * Downloads one file from posterna.com for a directory refresh.
	 *
	 * @param string $url URL under the base URL.
	 * @return array array( 'status', 'body' ).
	 * @throws \RuntimeException On a network error.
	 */
	public static function fetch( $url ) {
		$response = wp_remote_get(
			$url,
			array(
				'timeout'             => 10,
				'redirection'         => 0,
				'limit_response_size' => Directory_Store::MAX_FILE_BYTES + 1,
				'user-agent'          => 'Posterna-WordPress/' . POSTERNA_VERSION,
			)
		);
		if ( is_wp_error( $response ) ) {
			$exception = new \RuntimeException( 'download failed: ' . $response->get_error_message() );
			throw $exception;
		}
		return array(
			'status' => (int) wp_remote_retrieve_response_code( $response ),
			'body'   => (string) wp_remote_retrieve_body( $response ),
		);
	}

	/**
	 * The directory store.
	 *
	 * @return Directory_Store
	 */
	public function store() {
		if ( null === $this->store ) {
			$settings    = self::settings();
			$this->store = new Directory_Store(
				new Options_Directory_Storage(),
				array(
					'snapshot'        => array( __CLASS__, 'snapshot' ),
					'refresh'         => (bool) $settings['updates'],
					'base_url'        => self::base_url(),
					'fetch'           => array( __CLASS__, 'fetch' ),
					'on_keys_refresh' => function () {
						if ( false === wp_next_scheduled( self::CRON_REFRESH_KEYS ) ) {
							wp_schedule_single_event( time() + 10, self::CRON_REFRESH_KEYS );
						}
					},
				)
			);
			$this->store->load();
		}
		return $this->store;
	}

	/**
	 * The verifier.
	 *
	 * @return Verifier
	 */
	public function verifier() {
		if ( null === $this->verifier ) {
			// Reverse DNS and the nonce store are created only for requests that need them.
			$this->verifier = new Verifier(
				$this->store(),
				array( __CLASS__, 'rdns_cache' ),
				function () {
					return new Transient_Nonce_Store();
				},
				self::proxy_options( self::settings() )
			);
		}
		return $this->verifier;
	}

	/**
	 * True for requests that are labeled: front-end pages, feeds, REST,
	 * XML-RPC and log-in pages; not wp-admin, WP-Cron or WP-CLI.
	 *
	 * @return bool
	 */
	private static function is_visitor_request() {
		if ( ( defined( 'WP_CLI' ) && WP_CLI ) || wp_doing_cron() || wp_installing() ) {
			return false;
		}
		return ! is_admin();
	}

	/**
	 * Runs early on every request: upgrades if needed, then labels visitor
	 * requests before the theme loads.
	 */
	public function on_plugins_loaded() {
		try {
			if ( POSTERNA_VERSION !== get_option( self::VERSION_OPTION ) || ! Counter_Table::is_current() ) {
				self::upgrade();
			}
		} catch ( \Throwable $error ) {
			self::update_state( array( 'last_error' => 'upgrade: ' . $error->getMessage() ) );
		}
		if ( self::is_visitor_request() ) {
			$this->check();
		}
	}

	/**
	 * Labels this request once. Never throws and never blocks.
	 *
	 * @return array|null The verdict.
	 */
	public function check() {
		if ( null !== $this->verdict ) {
			return $this->verdict;
		}
		$started = hrtime( true );
		try {
			// Header values are read as sent, because signatures cover the exact bytes. They are
			// compared and verified only, never output or stored.
			$request = Request::from_server( $_SERVER ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			$client  = $this->verifier()->resolve( $request );

			$this->internal = null !== $client['address'] && $client['address']->internal;
			$this->verdict  = $this->verifier()->verify( $request );
			// Pass the verdict on to the rest of the site as core's adapters do (X-Agent-* request headers).
			foreach ( Verifier::verdict_headers( $this->verdict ) as $name => $value ) {
				$_SERVER[ 'HTTP_' . strtoupper( str_replace( '-', '_', $name ) ) ] = $value;
			}
		} catch ( \Throwable $error ) {
			$this->verdict = array(
				'verdict' => 'human',
				'method'  => 'none',
				'reason'  => 'unexpected_error',
				'error'   => 'unexpected error: ' . $error->getMessage(),
			);
		}
		$this->elapsed_ns = hrtime( true ) - $started;
		return $this->verdict;
	}

	/**
	 * The verdict for this request, checking it now if needed. Null in WP-CLI and WP-Cron.
	 *
	 * @return array|null
	 */
	public function verdict() {
		if ( null === $this->verdict && ! ( defined( 'WP_CLI' ) && WP_CLI ) && ! wp_doing_cron() ) {
			$this->check();
		}
		return $this->verdict;
	}

	/**
	 * Time the check took on this request, in milliseconds.
	 *
	 * @return float
	 */
	public function elapsed_ms() {
		return $this->elapsed_ns / 1e6;
	}

	/**
	 * Inbound verdict headers removed from this request.
	 *
	 * @return array
	 */
	public function stripped() {
		return $this->stripped;
	}

	/**
	 * Fires the posterna_verdict action once, on init, so plugins and themes can listen.
	 */
	public function announce() {
		if ( $this->announced || null === $this->verdict ) {
			return;
		}
		$this->announced = true;
		/**
		 * Fires once per labeled request, on init, with the verdict.
		 *
		 * @since 1.0.0
		 *
		 * @param array $verdict The verdict: 'verdict' and, when set, 'operator', 'agent',
		 *                       'purpose', 'method', 'reason', 'note' and 'error'.
		 */
		do_action( 'posterna_verdict', $this->verdict );
	}

	/**
	 * The request path without the query and without the site's own path prefix.
	 *
	 * @return string
	 */
	private static function site_path() {
		$uri  = isset( $_SERVER['REQUEST_URI'] ) && is_string( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- Only the first path segment is kept, and identifier-like segments are masked.
		$path = (string) wp_parse_url( $uri, PHP_URL_PATH );
		$base = (string) wp_parse_url( home_url( '/' ), PHP_URL_PATH );
		$base = rtrim( $base, '/' );
		if ( '' !== $base && 0 === strpos( $path, $base . '/' ) ) {
			$path = substr( $path, strlen( $base ) );
		}
		return '' === $path ? '/' : $path;
	}

	/**
	 * The path group for this request, with at most 50 groups per hour (the rest is "other").
	 *
	 * @param int $now Unix time.
	 * @return string
	 */
	private static function path_group( $now ) {
		$group  = Path_Group::first_segment( self::site_path() );
		$hour   = gmdate( 'Y-m-d H', $now );
		$groups = get_option( self::GROUPS_OPTION, array() );
		if ( ! is_array( $groups ) || ! isset( $groups['hour'], $groups['groups'] ) || $groups['hour'] !== $hour ) {
			$groups = array(
				'hour'   => $hour,
				'groups' => array(),
			);
		}
		if ( in_array( $group, $groups['groups'], true ) ) {
			return $group;
		}
		if ( count( $groups['groups'] ) >= self::MAX_PATH_GROUPS ) {
			return 'other';
		}
		$groups['groups'][] = $group;
		update_option( self::GROUPS_OPTION, $groups, true );
		return $group;
	}

	/**
	 * Counts this request at shutdown. Logged-in users are not counted.
	 */
	public function count_request() {
		if ( null === $this->verdict || ! self::is_visitor_request() || is_user_logged_in() ) {
			return;
		}
		try {
			$now = time();
			Counter_Table::record( 'page', $this->verdict, self::path_group( $now ), $this->internal, $now );
		} catch ( \Throwable $error ) {
			// Counting is best effort and never affects the request.
			return;
		}
	}

	/**
	 * Counts a sign-up by verdict. Monitor only: the sign-up always goes ahead.
	 */
	public function count_signup() {
		try {
			$verdict = $this->verdict();
			if ( null === $verdict ) {
				return;
			}
			$now = time();
			Counter_Table::record( 'signup', $verdict, Path_Group::first_segment( self::site_path() ), $this->internal, $now );
		} catch ( \Throwable $error ) {
			return;
		}
	}

	/**
	 * Creates the table, compiles the directory and schedules events. Runs on
	 * activation and once after each plugin update.
	 */
	public static function upgrade() {
		Counter_Table::install();
		update_option( self::VERSION_OPTION, POSTERNA_VERSION, true );
		if ( false === get_option( 'posterna_instance' ) ) {
			update_option( 'posterna_instance', bin2hex( random_bytes( 12 ) ), false );
		}
		self::sync_schedules();
		$plugin = self::instance();
		$store  = $plugin->store();
		$state  = $store->state();
		try {
			$bundled = self::snapshot();
		} catch ( \Throwable $error ) {
			self::update_state( array( 'last_error' => 'bundled directory: ' . $error->getMessage() ) );
			return;
		}
		$bundled_directory = isset( $bundled['directory']['version'] ) ? (string) $bundled['directory']['version'] : '';
		$bundled_keys      = isset( $bundled['keys']['version'] ) ? (string) $bundled['keys']['version'] : '';
		$loaded_directory  = is_array( $state ) && is_array( $state['directory'] ) ? (string) $state['directory']['version'] : null;
		$loaded_keys       = is_array( $state ) && is_array( $state['keys'] ) ? (string) $state['keys']['version'] : null;
		$downloaded        = is_array( $state ) && 'downloaded' === $state['source'];
		// A plugin update ships a new snapshot: use it, unless a downloaded copy is newer.
		if ( null === $loaded_directory
			|| ( ! $downloaded && ( $loaded_directory !== $bundled_directory || $loaded_keys !== $bundled_keys ) )
			|| ( $downloaded && strcmp( $bundled_directory, $loaded_directory ) > 0 ) ) {
			$store->load( true );
			$plugin->verifier = null;
		}
	}

	/**
	 * Activation: install everything for this site.
	 */
	public static function activate() {
		self::upgrade();
	}

	/**
	 * Deactivation: stop scheduled events. Data stays until the plugin is deleted.
	 */
	public static function deactivate() {
		foreach ( self::cron_hooks() as $hook ) {
			wp_clear_scheduled_hook( $hook );
		}
	}

	/**
	 * Every cron hook the plugin uses.
	 *
	 * @return array
	 */
	public static function cron_hooks() {
		return array( self::CRON_DAILY, self::CRON_HOURLY, self::CRON_SEND, self::CRON_REFRESH_NOW, self::CRON_REFRESH_KEYS, Transient_Rdns_Store::CRON_HOOK );
	}

	/**
	 * Schedules the events the settings call for, and removes the others.
	 */
	public static function sync_schedules() {
		$settings = self::settings();
		if ( false === wp_next_scheduled( self::CRON_DAILY ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', self::CRON_DAILY );
		}
		if ( $settings['updates'] ) {
			if ( false === wp_next_scheduled( self::CRON_HOURLY ) ) {
				wp_schedule_event( time() + HOUR_IN_SECONDS, 'hourly', self::CRON_HOURLY );
			}
		} else {
			wp_clear_scheduled_hook( self::CRON_HOURLY );
			wp_clear_scheduled_hook( self::CRON_REFRESH_KEYS );
		}
		if ( '' !== $settings['site_key'] ) {
			if ( false === wp_next_scheduled( self::CRON_SEND ) ) {
				wp_schedule_event( time() + 5 * MINUTE_IN_SECONDS, self::SEND_SCHEDULE, self::CRON_SEND );
			}
		} else {
			wp_clear_scheduled_hook( self::CRON_SEND );
		}
	}

	/**
	 * Records that a cron job ran.
	 *
	 * @param string $job Job name.
	 */
	private static function ran( $job ) {
		$state        = self::state();
		$runs         = isset( $state['runs'] ) && is_array( $state['runs'] ) ? $state['runs'] : array();
		$runs[ $job ] = time();
		self::update_state( array( 'runs' => $runs ) );
	}

	/**
	 * Daily: prune old counters, and refresh directory.json when updates are on.
	 */
	public function run_daily() {
		self::ran( 'daily' );
		Counter_Table::prune( time() );
		if ( self::settings()['updates'] ) {
			$this->refresh( 'directory' );
		}
	}

	/**
	 * Hourly: refresh keys.json when updates are on.
	 */
	public function run_hourly() {
		self::ran( 'hourly' );
		if ( self::settings()['updates'] ) {
			$this->refresh( 'keys' );
		}
	}

	/**
	 * Right after updates are turned on: refresh both files.
	 */
	public function refresh_now() {
		if ( self::settings()['updates'] ) {
			$this->refresh( 'directory' );
			$this->refresh( 'keys' );
		}
	}

	/**
	 * Early keys refresh after an unknown key id.
	 */
	public function refresh_keys() {
		if ( self::settings()['updates'] ) {
			$this->refresh( 'keys' );
		}
	}

	/**
	 * Refreshes one file and records the outcome.
	 *
	 * @param string $file 'directory' or 'keys'.
	 */
	private function refresh( $file ) {
		$store = $this->store();
		$ok    = 'directory' === $file ? $store->refresh_directory() : $store->refresh_keys();
		$state = self::state();

		$refresh          = isset( $state['refresh'] ) && is_array( $state['refresh'] ) ? $state['refresh'] : array();
		$refresh[ $file ] = array(
			'at'    => time(),
			'ok'    => $ok,
			'error' => $ok ? null : $store->last_error,
		);
		self::update_state( array( 'refresh' => $refresh ) );
		$this->verifier = null;
	}

	/**
	 * The reverse DNS cache: PHP's resolver, results in transients.
	 *
	 * @return Rdns_Cache
	 */
	public static function rdns_cache() {
		return new Rdns_Cache(
			Php_Dns_Resolver::available() ? new Php_Dns_Resolver() : null,
			array(),
			function () {
				return microtime( true ) * 1000;
			},
			new Transient_Rdns_Store()
		);
	}

	/**
	 * Works through queued reverse DNS lookups, a few at a time.
	 */
	public function run_rdns() {
		self::ran( 'rdns' );
		self::rdns_cache()->settle( 20, 10.0 );
		$queue = get_option( Transient_Rdns_Store::QUEUE_OPTION, array() );
		if ( is_array( $queue ) && array() !== $queue && false === wp_next_scheduled( Transient_Rdns_Store::CRON_HOOK ) ) {
			wp_schedule_single_event( time() + MINUTE_IN_SECONDS, Transient_Rdns_Store::CRON_HOOK );
		}
	}

	/**
	 * True when 80 percent or more of the last day's requests came from
	 * internal addresses (at least 200 requests): the site is probably behind
	 * a proxy it has not been told about.
	 *
	 * @return bool
	 */
	public static function proxy_suspect() {
		$mix = Counter_Table::address_mix( time() - DAY_IN_SECONDS );
		return $mix['hits'] >= 200 && $mix['internal'] >= 0.8 * $mix['hits'];
	}

	/**
	 * Sends unsent counters to posterna.com, when a site key is set. The
	 * payload is the same as core's counters client (docs/SPEC.md section 7):
	 * counts by hour, verdict, reason, operator, agent, purpose and path group.
	 * Never addresses, URLs, headers, bodies, user names or emails.
	 */
	public function send_counts() {
		$settings = self::settings();
		$key      = $settings['site_key'];
		if ( '' === $key ) {
			return;
		}
		self::ran( 'send' );
		$state = self::state();
		if ( isset( $state['key_rejected'] ) && hash( 'sha256', $key ) === $state['key_rejected'] ) {
			return;
		}
		$rows = Counter_Table::unsent( time() - 6 * DAY_IN_SECONDS, self::SEND_BATCH );
		if ( array() === $rows ) {
			return;
		}
		$buckets = array();
		$deltas  = array();
		foreach ( $rows as $row ) {
			$delta     = (int) $row['hits'] - (int) $row['sent'];
			$buckets[] = array(
				'hour'      => str_replace( ' ', 'T', substr( $row['hour_start'], 0, 13 ) ) . ':00:00Z',
				'verdict'   => $row['verdict'],
				'reason'    => '' === $row['reason'] ? null : $row['reason'],
				'operator'  => '' === $row['operator'] ? null : $row['operator'],
				'agent'     => '' === $row['agent'] ? null : $row['agent'],
				'purpose'   => '' === $row['purpose'] ? null : $row['purpose'],
				'pathGroup' => '' === $row['path_group'] ? 'other' : $row['path_group'],
				'action'    => 'allow',
				'enforced'  => false,
				'count'     => $delta,
				'bytes'     => 0,
			);

			$deltas[ (int) $row['id'] ] = $delta;
		}
		$index   = $this->store()->index();
		$payload = array(
			'schema'   => 1,
			'sdk'      => array(
				'name'    => 'posterna-wordpress',
				'version' => POSTERNA_VERSION,
				'runtime' => 'php-' . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
			),
			'instance' => (string) get_option( 'posterna_instance', 'unknown' ),
			'mode'     => 'monitor',
			'state'    => array(
				'proxySuspect'     => self::proxy_suspect(),
				'breakerTripped'   => array(),
				'guarded'          => 0,
				'errors'           => Counter_Table::fail_open_count( time() - DAY_IN_SECONDS ),
				'directoryVersion' => null === $index ? null : $index->directory_version(),
				'keysVersion'      => null === $index ? null : $index->keys_version(),
				'policyHash'       => null,
			),
			'buckets'  => $buckets,
		);
		$body    = wp_json_encode( $payload );
		$headers = array(
			'Authorization' => 'Bearer ' . $key,
			'Content-Type'  => 'application/json',
		);
		if ( function_exists( 'gzencode' ) ) {
			$zipped = gzencode( $body );
			if ( false !== $zipped ) {
				$body                        = $zipped;
				$headers['Content-Encoding'] = 'gzip';
			}
		}
		$response = wp_remote_post(
			self::base_url() . 'ingest',
			array(
				'timeout'     => 10,
				'redirection' => 0,
				'headers'     => $headers,
				'body'        => $body,
				'user-agent'  => 'Posterna-WordPress/' . POSTERNA_VERSION,
			)
		);
		if ( is_wp_error( $response ) ) {
			self::update_state(
				array(
					'send' => array(
						'at'    => time(),
						'ok'    => false,
						'error' => $response->get_error_message(),
					),
				)
			);
			return;
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( $code >= 200 && $code < 300 ) {
			Counter_Table::mark_sent( $deltas );
			$answer = json_decode( (string) wp_remote_retrieve_body( $response ), true );
			$update = array(
				'send' => array(
					'at'      => time(),
					'ok'      => true,
					'error'   => null,
					'buckets' => count( $buckets ),
				),
			);
			// The remote "return to monitor" override. Plugin 1.0 only monitors, so it changes
			// nothing yet; it is recorded and shown on the settings page.
			if ( is_array( $answer ) && array_key_exists( 'modeOverride', $answer ) && ( 'monitor' === $answer['modeOverride'] || null === $answer['modeOverride'] ) ) {
				$update['remote_override'] = $answer['modeOverride'];
			}
			self::update_state( $update );
			return;
		}
		$error = 'posterna.com answered ' . $code;
		if ( 401 === $code ) {
			// A revoked or mistyped key: stop sending until the key changes.
			self::update_state( array( 'key_rejected' => hash( 'sha256', $key ) ) );
		} elseif ( $code >= 400 && $code < 500 && 408 !== $code && 429 !== $code ) {
			// Refused for good: drop this batch, as core does.
			Counter_Table::mark_sent( $deltas );
		}
		self::update_state(
			array(
				'send' => array(
					'at'    => time(),
					'ok'    => false,
					'error' => $error,
				),
			)
		);
	}
}
