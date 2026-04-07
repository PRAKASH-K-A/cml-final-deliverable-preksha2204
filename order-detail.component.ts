import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { NotificationService } from '../../core/services/notification.service';
import { Order, AuditLog } from '../../core/models/models';

@Component({
  selector: 'app-order-detail',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div style="margin-bottom:16px">
      <a routerLink="/orders" class="btn btn-ghost btn-sm">← Back to Orders</a>
    </div>

    <div *ngIf="loading" class="empty-state"><div class="spinner"></div></div>

    <div *ngIf="order && !loading">
      <div class="page-header">
        <div>
          <h2 class="mono">{{ order.orderRefNumber }}</h2>
          <div class="page-subtitle">Order Detail & Audit Trail</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <span class="badge badge-{{order.status.toLowerCase()}}" style="font-size:13px;padding:6px 14px">
            {{ order.status }}
          </span>
          <button class="btn btn-danger" *ngIf="isCancellable(order)"
                  [disabled]="cancelling" (click)="cancelOrder()">
            {{ cancelling ? 'Cancelling...' : 'Cancel Order' }}
          </button>
        </div>
      </div>

      <div class="grid-2" style="margin-bottom:24px">
        <!-- Order Info -->
        <div class="card">
          <div class="section-title">Order Information</div>
          <div class="detail-grid">
            <div class="detail-row">
              <span class="detail-label">Symbol</span>
              <span class="detail-value mono" style="font-size:18px;font-weight:700;color:var(--accent-cyan)">{{ order.symbol }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Side</span>
              <span class="badge badge-{{order.side.toLowerCase()}}">{{ order.side }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Order Type</span>
              <span class="detail-value">{{ order.orderType }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Time in Force</span>
              <span class="detail-value">{{ order.timeInForce }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Quantity</span>
              <span class="detail-value mono">{{ order.quantity | number }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Filled Qty</span>
              <span class="detail-value mono" [class.text-amber]="order.filledQuantity > 0">
                {{ order.filledQuantity | number }}
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Price</span>
              <span class="detail-value mono text-green">\${{ order.price | number:'1.2-2' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Notional Value</span>
              <span class="detail-value mono">\${{ (order.quantity * order.price) | number:'1.2-2' }}</span>
            </div>
          </div>
        </div>

        <!-- Client & Time Info -->
        <div class="card">
          <div class="section-title">Client & Timestamps</div>
          <div class="detail-grid">
            <div class="detail-row">
              <span class="detail-label">Client ID</span>
              <span class="detail-value mono">{{ order.clientId || '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Client Name</span>
              <span class="detail-value">{{ order.clientName || '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Created At</span>
              <span class="detail-value mono">{{ order.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Last Updated</span>
              <span class="detail-value mono">{{ order.updatedAt | date:'yyyy-MM-dd HH:mm:ss' }}</span>
            </div>
            <div class="detail-row" *ngIf="order.rejectReason">
              <span class="detail-label">Reject Reason</span>
              <span class="detail-value text-red">{{ order.rejectReason }}</span>
            </div>
          </div>

          <!-- Status Timeline -->
          <div class="section-title" style="margin-top:20px">Current Status</div>
          <div class="status-display">
            <div class="status-icon badge-{{order.status.toLowerCase()}}"></div>
            <div>
              <div style="font-size:16px;font-weight:700">{{ order.status }}</div>
              <div style="font-size:12px;color:var(--text-muted)">{{ getStatusDescription(order.status) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Audit Trail -->
      <div class="card">
        <div class="section-title">Audit Trail</div>
        <div *ngIf="auditLogs.length === 0" class="empty-state" style="padding:30px">
          <div class="empty-icon">📋</div>
          <div class="empty-title">No audit events yet</div>
        </div>
        <div class="audit-timeline" *ngIf="auditLogs.length > 0">
          <div *ngFor="let log of auditLogs; let i = index" class="audit-item">
            <div class="audit-connector" *ngIf="i < auditLogs.length - 1"></div>
            <div class="audit-dot" [class]="'dot-' + getEventColor(log.eventType)"></div>
            <div class="audit-content">
              <div class="audit-header">
                <span class="audit-event" [class]="'text-' + getEventColor(log.eventType)">
                  {{ log.eventType }}
                </span>
                <span class="audit-time mono">{{ log.timestamp | date:'yyyy-MM-dd HH:mm:ss' }}</span>
              </div>
              <div class="audit-status-change" *ngIf="log.previousStatus || log.newStatus">
                <span *ngIf="log.previousStatus" class="badge badge-{{log.previousStatus.toLowerCase()}}">{{ log.previousStatus }}</span>
                <span *ngIf="log.previousStatus && log.newStatus" class="text-muted"> → </span>
                <span *ngIf="log.newStatus" class="badge badge-{{log.newStatus.toLowerCase()}}">{{ log.newStatus }}</span>
              </div>
              <div class="audit-details">{{ log.details }}</div>
              <div class="audit-by">by <strong>{{ log.initiatedBy }}</strong></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div *ngIf="!order && !loading" class="empty-state">
      <div class="empty-icon">❓</div>
      <div class="empty-title">Order not found</div>
      <a routerLink="/orders" class="btn btn-ghost" style="margin-top:12px">← Back to Orders</a>
    </div>
  `,
  styles: [`
    .detail-grid { display: flex; flex-direction: column; gap: 10px; }
    .detail-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid rgba(30,45,69,0.4); }
    .detail-row:last-child { border-bottom: none; }
    .detail-label { width: 130px; font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
    .detail-value { font-size: 14px; color: var(--text-primary); }

    .status-display { display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--bg-secondary); border-radius: var(--radius); }
    .status-icon { width: 14px; height: 14px; border-radius: 50%; }

    .audit-timeline { position: relative; padding-left: 28px; }
    .audit-item { position: relative; padding-bottom: 20px; }
    .audit-item:last-child { padding-bottom: 0; }
    .audit-dot {
      position: absolute; left: -28px; top: 4px;
      width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--bg-card);
    }
    .dot-blue   { background: var(--accent-blue); }
    .dot-green  { background: var(--accent-green); }
    .dot-red    { background: var(--accent-red); }
    .dot-amber  { background: var(--accent-amber); }
    .dot-purple { background: var(--accent-purple); }
    .dot-muted  { background: var(--text-muted); }

    .audit-connector {
      position: absolute; left: -23px; top: 16px; bottom: 0;
      width: 2px; background: var(--border);
    }
    .audit-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .audit-event { font-size: 13px; font-weight: 700; font-family: var(--text-mono); }
    .audit-time { font-size: 11px; color: var(--text-muted); }
    .audit-status-change { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
    .audit-details { font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
    .audit-by { font-size: 11px; color: var(--text-muted); }
  `]
})
export class OrderDetailComponent implements OnInit, OnDestroy {
  order: Order | null = null;
  auditLogs: AuditLog[] = [];
  loading = true;
  cancelling = false;
  private subs: Subscription[] = [];

  constructor(
    private route: ActivatedRoute,
    private api: ApiService,
    private ws: WebSocketService,
    private notify: NotificationService
  ) {}

  ngOnInit(): void {
    const ref = this.route.snapshot.paramMap.get('ref')!;
    this.api.getOrder(ref).subscribe({ next: o => { this.order = o; this.loading = false; }, error: () => this.loading = false });
    this.api.getOrderAudit(ref).subscribe(logs => this.auditLogs = logs);
    this.subs.push(
      this.ws.orderEvents$.subscribe(msg => {
        if (msg.payload.orderRefNumber === ref) {
          this.order = msg.payload;
          this.api.getOrderAudit(ref).subscribe(logs => this.auditLogs = logs);
        }
      })
    );
  }

  cancelOrder(): void {
    if (!this.order) return;
    this.cancelling = true;
    this.api.cancelOrder(this.order.orderRefNumber).subscribe({
      next: (o) => { this.order = o; this.notify.success('Cancelled', o.orderRefNumber); this.cancelling = false; this.api.getOrderAudit(o.orderRefNumber).subscribe(l => this.auditLogs = l); },
      error: (e) => { this.notify.error('Cancel failed', e.error?.message); this.cancelling = false; }
    });
  }

  isCancellable(o: Order): boolean { return ['NEW', 'PARTIAL'].includes(o.status); }

  getStatusDescription(status: string): string {
    const map: Record<string, string> = {
      NEW: 'Order received, awaiting matching',
      PARTIAL: 'Partially filled, remaining quantity active',
      FILLED: 'Fully executed — no further changes allowed',
      CANCELLED: 'Order cancelled successfully',
      REJECTED: 'Order rejected by validation or system',
      CANCEL_PENDING: 'Cancel request submitted, processing...',
      CANCEL_REJECTED: 'Cancel was rejected (order already filled)'
    };
    return map[status] || status;
  }

  getEventColor(eventType: string): string {
    if (eventType.includes('CREATED')) return 'blue';
    if (eventType.includes('CANCELLED') || eventType.includes('CANCEL_REQUESTED')) return 'amber';
    if (eventType.includes('REJECTED')) return 'red';
    if (eventType.includes('FILLED')) return 'green';
    if (eventType.includes('STATUS')) return 'purple';
    return 'muted';
  }

  ngOnDestroy(): void { this.subs.forEach(s => s.unsubscribe()); }
}
