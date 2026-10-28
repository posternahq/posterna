<?php
/**
 * Why a refreshed file was rejected.
 *
 * @package Posterna
 */

namespace Posterna\Directory;

defined( 'ABSPATH' ) || exit;

/**
 * Reasons as in docs/SPEC.md section 3.1: download_failed,
 * signature_malformed, signature_untrusted, signature_retired, invalid_file,
 * version_rollback, directory_missing.
 */
final class Refresh_Rejected extends \Exception {

	/**
	 * The reason code.
	 *
	 * @var string
	 */
	public $reason;

	/**
	 * Creates the rejection.
	 *
	 * @param string $reason  Reason code.
	 * @param string $message What happened. Never contains request data.
	 */
	public function __construct( $reason, $message ) {
		parent::__construct( $message );
		$this->reason = $reason;
	}
}
