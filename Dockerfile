FROM wordpress:7.1.5-php8.5-apache

WORKDIR /var/www/html
# Build native Apache output filter to blank Server header AFTER Apache sets it
# Build native Apache output filter to blank Server header AFTER Apache sets it
RUN apt-get update && apt-get install -y --no-install-recommends apache2-dev \
    && printf '%s\n' \
        '#include "httpd.h"' \
        '#include "http_config.h"' \
        '#include "http_protocol.h"' \
        '#include "http_request.h"' \
        '#include "util_filter.h"' \
        'static apr_status_t strip_server_filter(ap_filter_t *f, apr_bucket_brigade *bb) {' \
        '    apr_table_unset(f->r->headers_out, "Server");' \
        '    apr_table_setn(f->r->headers_out, "Server", "");' \
        '    ap_remove_output_filter(f);' \
        '    return ap_pass_brigade(f->next, bb);' \
        '}' \
        'static void insert_filter(request_rec *r) {' \
        '    ap_add_output_filter("STRIP_SERVER", NULL, r, r->connection);' \
        '}' \
        'static void register_hooks(apr_pool_t *p) {' \
        '    ap_register_output_filter("STRIP_SERVER", strip_server_filter, NULL, AP_FTYPE_PROTOCOL);' \
        '    ap_hook_insert_filter(insert_filter, NULL, NULL, APR_HOOK_LAST);' \
        '}' \
        'module AP_MODULE_DECLARE_DATA strip_server_module = {' \
        '    STANDARD20_MODULE_STUFF, NULL, NULL, NULL, NULL, NULL, register_hooks' \
        '};' > /tmp/mod_strip_server.c \
    && apxs -i -c /tmp/mod_strip_server.c \
    && echo "LoadModule strip_server_module /usr/lib/apache2/modules/mod_strip_server.so" > /etc/apache2/mods-available/strip_server.load \
    && a2enmod headers strip_server \
    && rm -f /tmp/mod_strip_server* \
    && apt-get purge -y --auto-remove apache2-dev \
    && rm -rf /var/lib/apt/lists/*

# Hide PHP version in response headers
RUN echo "expose_php = Off" > /usr/local/etc/php/conf.d/zz-security.ini

# Enforce ServerTokens Prod across both security.conf and zz-security-hardening.conf
RUN sed -i 's/^ServerTokens .*/ServerTokens Prod/' /etc/apache2/conf-available/security.conf \
    && sed -i 's/^ServerSignature .*/ServerSignature Off/' /etc/apache2/conf-available/security.conf \
    && printf "ServerTokens Prod\nServerSignature Off\n" > /etc/apache2/conf-available/zz-security-hardening.conf \
    && a2enconf zz-security-hardening

EXPOSE 80
CMD ["apache2-foreground"]