<?php
/**
 * HTTP Message Signature errors, with the same codes as Cloudflare's http-message-sig.
 *
 * @package Posterna
 */

namespace Posterna\Signature;

defined( 'ABSPATH' ) || exit;

/**
 * A signature that could not be checked or did not verify. The code says why,
 * using the names Cloudflare's library uses, so reason codes map the same way.
 */
final class Signature_Error extends \Exception {

	const MISSING_FIELD       = 'MissingField';
	const MALFORMED_FIELD     = 'MalformedField';
	const LABEL_REQUIRED      = 'LabelRequired';
	const LABEL_MISMATCH      = 'LabelMismatch';
	const DUPLICATE_LABEL     = 'DuplicateLabel';
	const INVALID_COMPONENT   = 'InvalidComponent';
	const DUPLICATE_COMPONENT = 'DuplicateComponent';
	const UNSUPPORTED_FEATURE = 'UnsupportedFeature';
	const ALGORITHM_MISMATCH  = 'AlgorithmMismatch';
	const POLICY_VIOLATION    = 'PolicyViolation';
	const VERIFICATION_FAILED = 'VerificationFailed';
	const RESOLVER_FAILED     = 'ResolverFailed';

	/**
	 * One of the constants above.
	 *
	 * @var string
	 */
	public $sig_code;

	/**
	 * Creates an error.
	 *
	 * @param string          $sig_code One of the constants above.
	 * @param string          $message  What went wrong. Never contains request data.
	 * @param \Throwable|null $cause    The error behind this one.
	 */
	public function __construct( $sig_code, $message, $cause = null ) {
		parent::__construct( $message, 0, $cause );
		$this->sig_code = $sig_code;
	}
}
