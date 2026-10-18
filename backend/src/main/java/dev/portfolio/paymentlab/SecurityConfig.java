package dev.portfolio.paymentlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.*;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.*;

@Configuration
public class SecurityConfig {
  @Bean
  SecurityFilterChain security(HttpSecurity http, Contexts contexts, ObjectMapper json)
      throws Exception {
    CsrfTokenRepository repo =
        new CsrfTokenRepository() {
          public CsrfToken generateToken(HttpServletRequest r) {
            return new DefaultCsrfToken(
                "X-CSRF-TOKEN", "_csrf", java.util.UUID.randomUUID().toString());
          }

          public CsrfToken loadToken(HttpServletRequest r) {
            var c = contexts.load(r);
            return c == null
                ? null
                : new DefaultCsrfToken("X-CSRF-TOKEN", "_csrf", c.data().get("csrf").toString());
          }

          // flow:SecurityConfig.csrf
          public void saveToken(CsrfToken token, HttpServletRequest r, HttpServletResponse s) {
            if (token != null) {
              var c = contexts.prepare(r, s);
              c.data().put("csrf", token.getToken());
              contexts.save(c);
            }
          }
        };
    http.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(
            c ->
                c.csrfTokenRepository(repo)
                    .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler())
                    .ignoringRequestMatchers("/internal/**", "/webhooks/**"))
        .formLogin(c -> c.disable())
        .httpBasic(c -> c.disable())
        .logout(c -> c.disable())
        .requestCache(c -> c.disable())
        .authorizeHttpRequests(a -> a.anyRequest().permitAll())
        .exceptionHandling(
            e ->
                e.accessDeniedHandler(
                    (r, s, x) -> {
                      s.setStatus(403);
                      s.setContentType("application/json;charset=UTF-8");
                      json.writeValue(
                          s.getOutputStream(),
                          java.util.Map.of(
                              "code", "CSRF_INVALID", "message", "요청 확인 정보가 올바르지 않습니다."));
                    }));
    return http.build();
  }
}
