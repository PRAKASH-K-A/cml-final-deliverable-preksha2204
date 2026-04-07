import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { NotificationService } from '../../core/services/notification.service';
import { Order, OrderCreateRequest, PageResponse, Security, Customer } from '../../core/models/models';

@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="page-header">
      <div>
        <h2>Orders</h2>
        <div class="page-subtitle">Live order book — {{ totalElements }} total orders</div>
      </div>
      <button class="btn btn-primary" (click)="showCreateModal = true">+ New Order</button>
    </div>

    <!-- Filters -->
    <div class="filters-row">
      <div class="form-group">
        <label>Symbol</label>
        <select class="form-control" [(ngModel)]="filters.symbol" (change)="applyFilters()">
          <option value="">All Symbols</option>
          <option *ngFor="let s of securities" [value]="s.symbol">{{ s.symbol }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>Status</label>
        <select class="form-control" [(ngModel)]="filters.status" (change)="applyFilters()">
          <option value="">All Statuses</option>
          <option *ngFor="let s of statuses" [value]="s">{{ s }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>Side</label>
        <select class="form-control" [(ngModel)]="filters.side" (change)="applyFilters()">
          <option value="">All</option>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
      </div>
      <div class="form-group">
        <label>Type</label>
        <select class="form-control" [(ngModel)]="filters.orderType" (change)="applyFilters()">
          <option value="">All Types</option>
          <option value="MARKET">MARKET</option>
          <option value="LIMIT">LIMIT</option>
          <option value="STOP">STOP</option>
        </select>
      </div>
      <button class="btn btn-ghost" (click)="resetFilters()">Reset</button>
    </div>

    <!-- Table -->
    <div class="card" style="padding:0">
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Order Ref</th><th>Symbol</th><th>Side</th><th>Type</th>
              <th>Qty</th><th>Filled</th><th>Price</th><th>Status</th>
              <th>Client</th><th>Created</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let o of orders" [class]="getRowClass(o)">
              <td>
                <a [routerLink]="['/orders', o.orderRefNumber]" class="mono text-blue" style="font-size:11px;text-decoration:none">
                  {{ o.orderRefNumber }}
                </a>
              </td>
              <td class="mono font-bold">{{ o.symbol }}</td>
              <td><span class="badge badge-{{o.side.toLowerCase()}}">{{ o.side }}</span></td>
              <td class="text-secondary" style="font-size:11px">{{ o.orderType }}</td>
              <td class="mono">{{ o.quantity | number }}</td>
              <td class="mono" [class.text-amber]="o.filledQuantity > 0">{{ o.filledQuantity | number }}</td>
              <td class="mono text-green">\${{ o.price | number:'1.2-2' }}</td>
              <td><span class="badge badge-{{o.status.toLowerCase()}}">{{ o.status }}</span></td>
              <td class="text-secondary" style="font-size:12px">{{ o.clientId }}</td>
              <td class="text-muted" style="font-size:11px">{{ o.createdAt | date:'MM/dd HH:mm:ss' }}</td>
              <td>
                <div style="display:flex;gap:6px">
                  <a [routerLink]="['/orders', o.orderRefNumber]" class="btn btn-ghost btn-sm">Detail</a>
                  <button class="btn btn-danger btn-sm"
                          [disabled]="!isCancellable(o)"
                          (click)="onCancelOrder(o)">Cancel</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div *ngIf="loading" class="empty-state"><div class="spinner"></div></div>
        <div *ngIf="!loading && !orders.length" class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-title">No orders found</div>
          <div class="empty-sub">Try adjusting your filters or create a new order</div>
        </div>
      </div>

      <!-- Pagination -->
      <div class="pagination" style="padding:12px 16px">
        <span class="page-info">{{ totalElements }} orders · Page {{ currentPage + 1 }} of {{ totalPages }}</span>
        <button class="btn btn-ghost btn-sm" [disabled]="currentPage === 0" (click)="goPage(currentPage - 1)">‹ Prev</button>
        <button class="btn btn-ghost btn-sm" [disabled]="currentPage >= totalPages - 1" (click)="goPage(currentPage + 1)">Next ›</button>
      </div>
    </div>

    <!-- Create Order Modal -->
    <div class="modal-overlay" *ngIf="showCreateModal" (click)="closeCreateModal($event)">
      <div class="modal">
        <div class="modal-header">
          <h3>New Order</h3>
          <button class="modal-close" (click)="showCreateModal = false">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div class="form-group">
            <label>Symbol *</label>
            <select class="form-control" [(ngModel)]="newOrder.symbol">
              <option value="">Select Symbol</option>
              <option *ngFor="let s of securities" [value]="s.symbol">{{ s.symbol }} — {{ s.companyName }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>Side *</label>
            <select class="form-control" [(ngModel)]="newOrder.side">
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>
          <div class="form-group">
            <label>Order Type *</label>
            <select class="form-control" [(ngModel)]="newOrder.orderType">
              <option value="LIMIT">LIMIT</option>
              <option value="MARKET">MARKET</option>
              <option value="STOP">STOP</option>
            </select>
          </div>
          <div class="form-group">
            <label>Time in Force</label>
            <select class="form-control" [(ngModel)]="newOrder.timeInForce">
              <option value="DAY">DAY</option>
              <option value="GTC">GTC</option>
              <option value="IOC">IOC</option>
              <option value="FOK">FOK</option>
            </select>
          </div>
          <div class="form-group">
            <label>Quantity *</label>
            <input class="form-control" type="number" [(ngModel)]="newOrder.quantity" placeholder="e.g. 100" min="1">
          </div>
          <div class="form-group">
            <label>Price *</label>
            <input class="form-control" type="number" [(ngModel)]="newOrder.price" placeholder="e.g. 185.00" step="0.01">
          </div>
          <div class="form-group">
            <label>Client ID</label>
            <select class="form-control" [(ngModel)]="newOrder.clientId" (change)="onClientChange()">
              <option value="">Select Client</option>
              <option *ngFor="let c of customers" [value]="c.clientId">{{ c.clientId }} — {{ c.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>Client Name</label>
            <input class="form-control" type="text" [(ngModel)]="newOrder.clientName" readonly placeholder="Auto-filled">
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px">
          <button class="btn btn-ghost" (click)="showCreateModal = false">Cancel</button>
          <button class="btn btn-success" (click)="submitOrder()" [disabled]="submitting">
            {{ submitting ? 'Submitting...' : 'Submit Order' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Cancel Confirm Modal -->
    <div class="modal-overlay" *ngIf="cancelTarget" (click)="cancelTarget = null">
      <div class="modal" style="min-width:380px" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h3>Confirm Cancel</h3>
          <button class="modal-close" (click)="cancelTarget = null">✕</button>
        </div>
        <p style="color:var(--text-secondary);margin-bottom:16px">
          Are you sure you want to cancel order <strong class="mono text-blue">{{ cancelTarget?.orderRefNumber }}</strong>?
        </p>
        <div class="card" style="padding:12px;margin-bottom:16px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
            <div><span class="text-muted">Symbol:</span> <span class="mono">{{ cancelTarget?.symbol }}</span></div>
            <div><span class="text-muted">Side:</span> <span class="badge badge-{{cancelTarget?.side?.toLowerCase()}}">{{ cancelTarget?.side }}</span></div>
            <div><span class="text-muted">Qty:</span> <span class="mono">{{ cancelTarget?.quantity | number }}</span></div>
            <div><span class="text-muted">Price:</span> <span class="mono">\${{ cancelTarget?.price | number:'1.2-2' }}</span></div>
          </div>
        </div>
        <p style="font-size:12px;color:var(--accent-amber);margin-bottom:16px">
          ⚠ If the order is already filled, this cancel will be rejected.
        </p>
        <div style="display:flex;justify-content:flex-end;gap:10px">
          <button class="btn btn-ghost" (click)="cancelTarget = null">No, Keep It</button>
          <button class="btn btn-danger" (click)="confirmCancel()" [disabled]="cancelling">
            {{ cancelling ? 'Cancelling...' : 'Yes, Cancel Order' }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .font-bold { font-weight: 600; }
    tr.highlight-new    { border-left: 3px solid var(--accent-blue); }
    tr.highlight-filled { border-left: 3px solid var(--accent-green); }
    tr.highlight-cancel { border-left: 3px solid var(--accent-amber); }
  `]
})
export class OrderListComponent implements OnInit, OnDestroy {
  orders: Order[] = [];
  securities: Security[] = [];
  customers: Customer[] = [];
  statuses = ['NEW', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED', 'CANCEL_PENDING', 'CANCEL_REJECTED'];

  filters: any = { symbol: '', status: '', side: '', orderType: '', page: 0, size: 20 };
  currentPage = 0;
  totalPages = 0;
  totalElements = 0;
  loading = false;
  showCreateModal = false;
  submitting = false;
  cancelTarget: Order | null = null;
  cancelling = false;

  newOrder: Partial<OrderCreateRequest> = {
    side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', quantity: 100, price: 100
  };

  private subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private ws: WebSocketService,
    private notify: NotificationService
  ) {}

  ngOnInit(): void {
    this.loadOrders();
    this.api.getSecurities().subscribe(s => this.securities = s);
    this.api.getCustomers().subscribe(c => this.customers = c);
    this.subs.push(
      this.ws.orderEvents$.subscribe(msg => {
        const o = msg.payload;
        const idx = this.orders.findIndex(x => x.orderRefNumber === o.orderRefNumber);
        if (idx >= 0) {
          this.orders[idx] = o;
          this.orders = [...this.orders];
        } else if (msg.eventType === 'CREATED') {
          this.orders = [o, ...this.orders];
          this.totalElements++;
        }
        this.notify.info(`Order ${msg.eventType}`, o.orderRefNumber);
      })
    );
  }

  loadOrders(): void {
    this.loading = true;
    this.api.getOrders({ ...this.filters, page: this.currentPage }).subscribe({
      next: (p: PageResponse<Order>) => {
        this.orders = p.content;
        this.totalPages = p.totalPages;
        this.totalElements = p.totalElements;
        this.loading = false;
      },
      error: () => { this.loading = false; }
    });
  }

  applyFilters(): void { this.currentPage = 0; this.loadOrders(); }
  resetFilters(): void { this.filters = { symbol: '', status: '', side: '', orderType: '' }; this.applyFilters(); }
  goPage(p: number): void { this.currentPage = p; this.loadOrders(); }

  isCancellable(o: Order): boolean {
    return ['NEW', 'PARTIAL'].includes(o.status);
  }

  onCancelOrder(o: Order): void { this.cancelTarget = o; }

  confirmCancel(): void {
    if (!this.cancelTarget) return;
    this.cancelling = true;
    this.api.cancelOrder(this.cancelTarget.orderRefNumber).subscribe({
      next: (o) => {
        this.notify.success('Cancel processed', `Order ${o.orderRefNumber} → ${o.status}`);
        this.cancelling = false;
        this.cancelTarget = null;
        this.loadOrders();
      },
      error: (e) => {
        this.notify.error('Cancel failed', e.error?.message);
        this.cancelling = false;
      }
    });
  }

  submitOrder(): void {
    if (!this.newOrder.symbol || !this.newOrder.quantity || !this.newOrder.price) {
      this.notify.error('Validation', 'Symbol, quantity and price are required');
      return;
    }
    this.submitting = true;
    this.api.createOrder(this.newOrder as OrderCreateRequest).subscribe({
      next: (o) => {
        this.notify.success('Order Created', o.orderRefNumber);
        this.submitting = false;
        this.showCreateModal = false;
        this.newOrder = { side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', quantity: 100, price: 100 };
        this.loadOrders();
      },
      error: (e) => {
        this.notify.error('Order failed', e.error?.message);
        this.submitting = false;
      }
    });
  }

  onClientChange(): void {
    const c = this.customers.find(x => x.clientId === this.newOrder.clientId);
    this.newOrder.clientName = c?.name || '';
  }

  closeCreateModal(e: Event): void {
    if ((e.target as HTMLElement).classList.contains('modal-overlay')) this.showCreateModal = false;
  }

  getRowClass(o: Order): string {
    if (o.status === 'NEW') return 'highlight-new';
    if (o.status === 'FILLED') return 'highlight-filled';
    if (o.status === 'CANCEL_PENDING') return 'highlight-cancel';
    return '';
  }

  ngOnDestroy(): void { this.subs.forEach(s => s.unsubscribe()); }
}
