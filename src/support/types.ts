import type { Pool } from "pg";
import type { AccountPagination } from "../access/contract";
import type { AccessResult, AuditWriter, HumanActor } from "../access/types";
import type { Customers } from "../customers/types";
import type { Services } from "../services/types";
import type {
  TicketsResponse,
  TicketResponse,
  OpenTicketRequest,
  ReplyRequest,
  AddNoteRequest,
  ProposeRequest,
  ApproveRequest,
  RecordResultRequest,
} from "./contract";
export interface SupportOptions {
  pool: Pool;
  authorizeCustomer: Customers["authorizeCustomer"];
  audit: AuditWriter;
  readTarget: Services["readTarget"];
}
/** Human-only customer-scoped support. Commands consume unique request IDs and roll back with failed audit. No service, billing or provider effects. */
export interface Support {
  /** Requires read_support; lists public ticket activity with bounded stable pagination. */
  listTickets(
    actor: HumanActor,
    customerId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<TicketsResponse>>;
  /** Requires read_support; filters internal notes before counting/paging unless current support staff. */
  getTicket(
    actor: HumanActor,
    customerId: string,
    ticketId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<TicketResponse>>;
  /** Requires request_support and an owned service/component; creates the ticket and first public reply atomically. */
  openTicket(
    actor: HumanActor,
    customerId: string,
    input: OpenTicketRequest,
  ): Promise<AccessResult<TicketResponse>>;
  /** Requires request_support and current ticket version; appends a public reply and reopens resolved tickets. */
  reply(
    actor: HumanActor,
    customerId: string,
    ticketId: string,
    input: ReplyRequest,
  ): Promise<AccessResult<TicketResponse>>;
  /** Requires manage_support and current public version; appends a private note without changing public activity/version. */
  addNote(
    actor: HumanActor,
    customerId: string,
    ticketId: string,
    input: AddNoteRequest,
  ): Promise<AccessResult<TicketResponse>>;
  /** Requires manage_support and an open current-version ticket; snapshots targets server-side and supersedes prior approval. */
  propose(
    actor: HumanActor,
    customerId: string,
    ticketId: string,
    input: ProposeRequest,
  ): Promise<AccessResult<TicketResponse>>;
  /** Requires current administrator membership, exact latest proposal and unchanged targets. Self-prepared, self-invited and unknown disclosures refuse consent. */
  approve(
    actor: HumanActor,
    customerId: string,
    ticketId: string,
    input: ApproveRequest,
  ): Promise<AccessResult<TicketResponse>>;
  /** Requires manage_support and current ticket version; records human verification and resolves. Completed work needs exact latest approval and target ownership; unchanged work requires none. verifiedAt accepts an explicit instant or "now" resolved by the server for a fresh command. Reused requests still conflict without changing the recorded time; callers reload the ticket after an uncertain outcome. */
  recordResult(
    actor: HumanActor,
    customerId: string,
    ticketId: string,
    input: RecordResultRequest,
  ): Promise<AccessResult<TicketResponse>>;
}
