package com.dsh.mc.link;

/**
 * An error that maps directly to an HTTP status + {@code {ok:false,error:{code,message}}} body.
 */
final class ApiException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    final int status;
    final String code;

    ApiException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    ApiException(int status, String code, String message, Throwable cause) {
        super(message, cause);
        this.status = status;
        this.code = code;
    }
}
