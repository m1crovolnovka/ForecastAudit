package org.example.weatherapp.audit;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClientException;

@RestController
public class AuditController {

    private final AuditService auditService;

    public AuditController(AuditService auditService) {
        this.auditService = auditService;
    }

    @GetMapping("/api/audit")
    public AuditReport audit() {
        return auditService.report();
    }

    @ExceptionHandler({RestClientException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> handleUpstream(RuntimeException cause) {
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(Map.of("error", "Источники данных недоступны: " + cause.getMessage()));
    }
}
