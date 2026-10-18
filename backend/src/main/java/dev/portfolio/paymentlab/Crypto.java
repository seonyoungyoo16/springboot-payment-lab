package dev.portfolio.paymentlab;

import java.net.IDN;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.stereotype.Component;

@Component
public class Crypto {
  private final byte[] root;
  private final SecureRandom random = new SecureRandom();
  public final Argon2PasswordEncoder encoder = new Argon2PasswordEncoder(16, 32, 1, 19456, 2);

  public Crypto(@Value("${lab.crypto}") String key) {
    root = Base64.getDecoder().decode(key);
    if (root.length != 32) throw new IllegalStateException("Project crypto key missing");
  }

  public static String hash(String text) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public String random() {
    byte[] b = new byte[32];
    random.nextBytes(b);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }

  public String hmac(String purpose, String value) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(root, "HmacSHA256"));
      return HexFormat.of()
          .formatHex(mac.doFinal((purpose + "\0" + value).getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public static boolean equal(String a, String b) {
    return a != null
        && b != null
        && MessageDigest.isEqual(
            a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
  }

  // flow:Crypto.encrypt
  public String encrypt(String purpose, String aad, String text) {
    try {
      byte[] nonce = new byte[12];
      random.nextBytes(nonce);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(
          Cipher.ENCRYPT_MODE,
          new SecretKeySpec(HexFormat.of().parseHex(hmac("encryption", purpose)), "AES"),
          new GCMParameterSpec(128, nonce));
      c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
      byte[] body = c.doFinal(text.getBytes(StandardCharsets.UTF_8));
      return Base64.getEncoder().encodeToString(nonce)
          + "."
          + Base64.getEncoder().encodeToString(body);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public String decrypt(String purpose, String aad, String text) {
    try {
      String[] parts = text.split("\\.", 2);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(
          Cipher.DECRYPT_MODE,
          new SecretKeySpec(HexFormat.of().parseHex(hmac("encryption", purpose)), "AES"),
          new GCMParameterSpec(128, Base64.getDecoder().decode(parts[0])));
      c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
      return new String(c.doFinal(Base64.getDecoder().decode(parts[1])), StandardCharsets.UTF_8);
    } catch (Exception e) {
      throw Failure.unavailable();
    }
  }

  // flow:Crypto.email
  public static String email(String input) {
    if (input == null || input.length() > 254)
      throw new Failure(400, "INVALID_EMAIL", "이메일 형식을 확인해 주세요.");
    String s = input.strip();
    int at = s.lastIndexOf('@');
    if (at < 1 || at != s.indexOf('@') || at > 64)
      throw new Failure(400, "INVALID_EMAIL", "이메일 형식을 확인해 주세요.");
    String local = s.substring(0, at);
    if (!local.matches("[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+")
        || local.startsWith(".")
        || local.endsWith(".")
        || local.contains("..")) throw new Failure(400, "INVALID_EMAIL", "ASCII 이메일 주소를 사용해 주세요.");
    try {
      String domain =
          IDN.toASCII(s.substring(at + 1), IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
      if (!domain.contains(".") || domain.length() > 253 || domain.endsWith("."))
        throw new IllegalArgumentException();
      String key = local.toLowerCase(Locale.ROOT) + "@" + domain;
      if (key.length() > 254) throw new IllegalArgumentException();
      return key;
    } catch (Exception e) {
      throw new Failure(400, "INVALID_EMAIL", "이메일 도메인을 확인해 주세요.");
    }
  }

  public static String deliveryEmail(String original) {
    String canonical = email(original), raw = original.strip();
    return raw.substring(0, raw.lastIndexOf('@')) + canonical.substring(canonical.lastIndexOf('@'));
  }

  public void password(String value) {
    if (value == null
        || value.codePointCount(0, value.length()) < 15
        || value.codePointCount(0, value.length()) > 128
        || value.getBytes(StandardCharsets.UTF_8).length > 1024
        || Set.of("passwordpassword", "123456789012345").contains(value.toLowerCase(Locale.ROOT)))
      throw new Failure(400, "WEAK_PASSWORD", "비밀번호는 15~128자로 입력해 주세요. 공백·한글을 그대로 사용합니다.");
  }

  public String encode(String password) {
    return "{argon2id}" + encoder.encode(password);
  }

  public boolean matches(String password, String encoded) {
    return encoded != null
        && encoded.startsWith("{argon2id}")
        && encoder.matches(password, encoded.substring(10));
  }
}
