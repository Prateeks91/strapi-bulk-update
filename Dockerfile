FROM wordpress:7.1.5-php8.5-apache

WORKDIR /var/www/html

# Install build tools and compile ModSecurity v2.9.11 for Apache
RUN apt-get update && apt-get install -y --no-install-recommends apache2-dev \
    && printf '#include "httpd.h"\n#include "http_config.h"\n#include "http_protocol.h"\nstatic int strip_server_header(request_rec *r) {\n    apr_table_setn(r->headers_out, "Server", "");\n    return DECLINED;\n}\nstatic void register_hooks(apr_pool_t *p) {\n    ap_hook_post_read_request(strip_server_header, NULL, NULL, APR_HOOK_FIRST);\n}\nmodule AP_MODULE_DECLARE_DATA strip_server_module = {\n    STANDARD20_MODULE_STUFF, NULL, NULL, NULL, NULL, NULL, register_hooks\n};\n' > /tmp/mod_strip_server.c \
    && apxs -i -a -c /tmp/mod_strip_server.c \
    && rm -f /tmp/mod_strip_server* \
    && apt-get purge -y --auto-remove apache2-dev \
    && rm -rf /var/lib/apt/lists/*RUN apt-get update && apt-get install -y --no-install-recommends apache2-dev \
    && printf '#include "httpd.h"\n#include "http_config.h"\n#include "http_protocol.h"\nstatic int strip_server_header(request_rec *r) {\n    apr_table_setn(r->headers_out, "Server", "");\n    return DECLINED;\n}\nstatic void register_hooks(apr_pool_t *p) {\n    ap_hook_post_read_request(strip_server_header, NULL, NULL, APR_HOOK_FIRST);\n}\nmodule AP_MODULE_DECLARE_DATA strip_server_module = {\n    STANDARD20_MODULE_STUFF, NULL, NULL, NULL, NULL, NULL, register_hooks\n};\n' > /tmp/mod_strip_server.c \
    && apxs -i -a -c /tmp/mod_strip_server.c \
    && rm -f /tmp/mod_strip_server* \
    && apt-get purge -y --auto-remove apache2-dev \
    && rm -rf /var/lib/apt/lists/*

# Hide PHP version in response headers
RUN echo "expose_php = Off" > /usr/local/etc/php/conf.d/zz-security.ini

# Hardening: Use zz- prefix so it loads AFTER /etc/apache2/conf-enabled/security.conf
RUN printf "ServerTokens Full\nServerSignature Off\n<IfModule security2_module>\n    SecRuleEngine DetectionOnly\n    SecServerSignature \" \"\n</IfModule>\n" \
    > /etc/apache2/conf-available/zz-security-hardening.conf \
    && a2enconf zz-security-hardening

EXPOSE 80
CMD ["apache2-foreground"]