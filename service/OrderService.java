package com.trading.platform.service;

import com.trading.platform.dto.*;
import com.trading.platform.entity.AuditLog;
import com.trading.platform.entity.Order;
import com.trading.platform.fix.FixGatewayService;
import com.trading.platform.repository.AuditLogRepository;
import com.trading.platform.repository.OrderRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * Order lifecycle service wired to MiniFIX via FIX 4.4.
 *
 * Flow:
 *  createOrder()  → saves to DB → sends NewOrderSingle to MiniFIX
 *  cancelOrder()  → saves CANCEL_PENDING → sends OrderCancelRequest to MiniFIX
 *  updateOrderFromFix() → called by FixApplication when ExecutionReport arrives
 *                       → updates DB status + broadcasts via WebSocket
 */
@Service
@Slf4j
public class OrderService {

    private final OrderRepository orderRepository;
    private final AuditLogRepository auditLogRepository;
    private final WebSocketBroadcastService broadcastService;
    private final FixGatewayService fixGatewayService;

    private final AtomicLong orderCounter = new AtomicLong(1000);

    // ClOrdID ↔ orderRefNumber correlation maps
    private final Map<String, String> clOrdIdToRef = new ConcurrentHashMap<>();
    private final Map<String, String> refToClOrdId = new ConcurrentHashMap<>();

    // @Lazy on FixGatewayService breaks the circular dependency:
    // OrderService → FixGatewayService → FixApplication → [lazy] OrderService
    public OrderService(OrderRepository orderRepository,
                        AuditLogRepository auditLogRepository,
                        WebSocketBroadcastService broadcastService,
                        @Lazy FixGatewayService fixGatewayService) {
        this.orderRepository   = orderRepository;
        this.auditLogRepository = auditLogRepository;
        this.broadcastService  = broadcastService;
        this.fixGatewayService = fixGatewayService;
    }

    // ─── Create Order ─────────────────────────────────────────────────

    @Transactional
    public OrderDTO createOrder(OrderCreateRequest req) {
        String ref = generateOrderRef();

        Order order = Order.builder()
                .orderRefNumber(ref)
                .symbol(req.getSymbol().toUpperCase())
                .side(req.getSide())
                .quantity(req.getQuantity())
                .filledQuantity(BigDecimal.ZERO)
                .price(req.getPrice())
                .orderType(req.getOrderType())
                .timeInForce(req.getTimeInForce())
                .clientId(req.getClientId())
                .clientName(req.getClientName())
                .status(Order.OrderStatus.NEW)
                .build();

        order = orderRepository.save(order);
        saveAudit(ref, "ORDER_CREATED", null, "NEW", "Order created via UI", "user");
        log.info("[ORDER] Created: {} {} {} @ {}", ref, order.getSide(), order.getSymbol(), order.getPrice());

        // ── Send to MiniFIX simulator via FIX 4.4 ────────────────────
        try {
            String clOrdId = fixGatewayService.sendOrder(order);
            // Store mapping so we can correlate ExecutionReports back to this order
            clOrdIdToRef.put(clOrdId, ref);
            refToClOrdId.put(ref, clOrdId);
            saveAudit(ref, "FIX_SENT", "NEW", "NEW",
                    "NewOrderSingle sent to MiniFIX. ClOrdID=" + clOrdId, "fix-gateway");
            log.info("[ORDER] ✅ FIX order sent: {} → ClOrdID={}", ref, clOrdId);
        } catch (Exception e) {
            log.warn("[ORDER] ⚠️  FIX send failed (MiniFIX offline?): {}. Order saved to DB.", e.getMessage());
            saveAudit(ref, "FIX_SEND_FAILED", "NEW", "NEW",
                    "FIX send failed: " + e.getMessage(), "fix-gateway");
        }

        OrderDTO dto = OrderDTO.fromEntity(order);
        broadcastService.broadcastOrder("CREATED", dto);
        return dto;
    }

    // ─── Cancel Order ─────────────────────────────────────────────────

    @Transactional
    public OrderDTO cancelOrder(String orderRefNumber) {
        Order order = orderRepository.findByOrderRefNumber(orderRefNumber)
                .orElseThrow(() -> new RuntimeException("Order not found: " + orderRefNumber));

        // Already filled → reject the cancel
        if (order.getStatus() == Order.OrderStatus.FILLED) {
            String prev = order.getStatus().name();
            order.setStatus(Order.OrderStatus.CANCEL_REJECTED);
            order.setRejectReason("Cannot cancel a fully filled order");
            order = orderRepository.save(order);
            saveAudit(orderRefNumber, "CANCEL_REJECTED", prev, "CANCEL_REJECTED",
                    "Cancel rejected: order already filled", "system");
            OrderDTO dto = OrderDTO.fromEntity(order);
            broadcastService.broadcastOrder("CANCEL_REJECTED", dto);
            return dto;
        }

        if (order.getStatus() == Order.OrderStatus.CANCELLED ||
            order.getStatus() == Order.OrderStatus.REJECTED) {
            throw new RuntimeException("Order already in terminal state: " + order.getStatus());
        }

        // Move to CANCEL_PENDING immediately — UI reflects this right away
        String prev = order.getStatus().name();
        order.setStatus(Order.OrderStatus.CANCEL_PENDING);
        order = orderRepository.save(order);
        saveAudit(orderRefNumber, "CANCEL_REQUESTED", prev, "CANCEL_PENDING",
                "Cancel requested by user", "user");
        broadcastService.broadcastOrder("CANCEL_PENDING", OrderDTO.fromEntity(order));

        // ── Send OrderCancelRequest to MiniFIX ────────────────────────
        String origClOrdId = refToClOrdId.get(orderRefNumber);
        if (origClOrdId != null) {
            try {
                String newClOrdId = fixGatewayService.sendCancelOrder(order, origClOrdId);
                clOrdIdToRef.put(newClOrdId, orderRefNumber);
                refToClOrdId.put(orderRefNumber, newClOrdId);
                saveAudit(orderRefNumber, "FIX_CANCEL_SENT", "CANCEL_PENDING", "CANCEL_PENDING",
                        "OrderCancelRequest sent to MiniFIX. NewClOrdID=" + newClOrdId, "fix-gateway");
                log.info("[ORDER] ✅ FIX cancel sent: {} → NewClOrdID={}", orderRefNumber, newClOrdId);
                // Return CANCEL_PENDING — actual CANCELLED comes via ExecutionReport from MiniFIX
                return OrderDTO.fromEntity(order);
            } catch (Exception e) {
                log.warn("[ORDER] FIX cancel send failed: {}. Cancelling locally.", e.getMessage());
            }
        }

        // Fallback: cancel locally (MiniFIX not connected or no ClOrdID on record)
        order.setStatus(Order.OrderStatus.CANCELLED);
        order = orderRepository.save(order);
        saveAudit(orderRefNumber, "ORDER_CANCELLED", "CANCEL_PENDING", "CANCELLED",
                "Cancelled locally (FIX not connected)", "system");
        OrderDTO dto = OrderDTO.fromEntity(order);
        broadcastService.broadcastOrder("CANCELLED", dto);
        return dto;
    }

    // ─── Called by FixApplication when ExecutionReport arrives ────────

    @Transactional
    public void updateOrderFromFix(String clOrdId, Order.OrderStatus newStatus,
                                   BigDecimal cumQty, BigDecimal avgPx,
                                   String execType, String rejectReason) {
        String orderRef = clOrdIdToRef.get(clOrdId);
        if (orderRef == null) {
            log.warn("[FIX] No order mapped for ClOrdID={} — ExecutionReport ignored", clOrdId);
            return;
        }

        orderRepository.findByOrderRefNumber(orderRef).ifPresent(order -> {
            String prev = order.getStatus().name();
            order.setStatus(newStatus);

            if (cumQty != null && cumQty.compareTo(BigDecimal.ZERO) > 0) {
                order.setFilledQuantity(cumQty);
            }
            if (rejectReason != null && !rejectReason.isBlank()) {
                order.setRejectReason(rejectReason);
            }

            Order saved = orderRepository.save(order);
            String detail = String.format(
                    "ExecutionReport from MiniFIX. ExecType=%s CumQty=%s AvgPx=%s",
                    execType, cumQty, avgPx);
            saveAudit(orderRef, "FIX_EXECUTION_REPORT", prev, newStatus.name(), detail, "minifix");

            log.info("[FIX] Order {} updated: {} → {} (CumQty={} AvgPx={})",
                    orderRef, prev, newStatus, cumQty, avgPx);

            broadcastService.broadcastOrder("UPDATED", OrderDTO.fromEntity(saved));
        });
    }

    // ─── Queries ──────────────────────────────────────────────────────

    public Page<OrderDTO> getOrders(String symbol, String status, String clientId,
                                    String side, String orderType,
                                    LocalDateTime from, LocalDateTime to, Pageable pageable) {
        Order.OrderStatus st = status   != null ? Order.OrderStatus.valueOf(status)   : null;
        Order.OrderSide   sd = side     != null ? Order.OrderSide.valueOf(side)       : null;
        Order.OrderType   ot = orderType!= null ? Order.OrderType.valueOf(orderType)  : null;
        return orderRepository.findWithFilters(symbol, st, clientId, sd, ot, from, to, pageable)
                .map(OrderDTO::fromEntity);
    }

    public OrderDTO getOrderByRef(String ref) {
        return orderRepository.findByOrderRefNumber(ref)
                .map(OrderDTO::fromEntity)
                .orElseThrow(() -> new RuntimeException("Order not found: " + ref));
    }

    public List<AuditLogDTO> getOrderAuditTrail(String orderRefNumber) {
        return auditLogRepository.findByOrderRefNumberOrderByTimestampAsc(orderRefNumber)
                .stream().map(AuditLogDTO::fromEntity).collect(Collectors.toList());
    }

    public List<OrderDTO> getRecentOrders() {
        return orderRepository.findTop10ByOrderByCreatedAtDesc()
                .stream().map(OrderDTO::fromEntity).collect(Collectors.toList());
    }

    public DashboardStats getDashboardStats() {
        long total     = orderRepository.count();
        long active    = orderRepository.countByStatus(Order.OrderStatus.NEW)
                       + orderRepository.countByStatus(Order.OrderStatus.PARTIAL);
        long cancelled = orderRepository.countByStatus(Order.OrderStatus.CANCELLED);
        long filled    = orderRepository.countByStatus(Order.OrderStatus.FILLED);
        long rejected  = orderRepository.countByStatus(Order.OrderStatus.REJECTED);

        List<Object[]> grouped = orderRepository.countByStatusGrouped();
        Map<String, Long> byStatus = grouped.stream()
                .collect(Collectors.toMap(r -> r[0].toString(), r -> (Long) r[1]));

        return DashboardStats.builder()
                .totalOrders(total).totalTrades(0L)
                .activeOrders(active).cancelledOrders(cancelled)
                .filledOrders(filled).rejectedOrders(rejected)
                .ordersByStatus(byStatus)
                .build();
    }

    // ─── Private Helpers ──────────────────────────────────────────────

    private String generateOrderRef() {
        String ts = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss"));
        return "ORD-" + ts + "-" + String.format("%04d", orderCounter.getAndIncrement());
    }

    private void saveAudit(String ref, String eventType, String prev, String next,
                           String details, String initiatedBy) {
        auditLogRepository.save(AuditLog.builder()
                .orderRefNumber(ref).eventType(eventType)
                .previousStatus(prev).newStatus(next)
                .details(details).initiatedBy(initiatedBy)
                .build());
    }
}
