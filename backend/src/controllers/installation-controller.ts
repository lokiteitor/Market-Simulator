/**
 * Controller de `/agents/me/installations` y `/catalog/installation-types`
 * (economía de instalaciones, ADR-021).
 *
 * Convierte dominio (camelCase) ↔ contrato HTTP (snake_case). La validación de
 * entrada la hace Zod en las rutas; aquí solo se mapea.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AcquireInstallationRequest,
  AcquireInstallationResponseJson,
  InstallationTypeJson,
} from "../schemas/installations";
import type { InstallationStatusJson } from "../schemas/agents";
import {
  installationService,
  type AcquireInstallationResult,
  type InstallationStatusView,
  type InstallationTypeView,
} from "../services/installation-service";

function toStatusJson(i: InstallationStatusView): InstallationStatusJson {
  return {
    installation_type: i.installationType,
    name: i.name,
    unit_label: i.unitLabel,
    level: i.level,
    running: i.running,
    available_slots: i.availableSlots,
    next_upgrade_price_cents: i.nextUpgradePriceCents,
  };
}

function toTypeJson(t: InstallationTypeView): InstallationTypeJson {
  return {
    installation_type_id: t.installationTypeId,
    key: t.key,
    name: t.name,
    role: t.role as InstallationTypeJson["role"],
    unit_label: t.unitLabel,
    base_price_cents: t.basePriceCents,
    growth_bps: t.growthBps,
    max_level: t.maxLevel,
  };
}

function toAcquireResponseJson(
  r: AcquireInstallationResult,
): AcquireInstallationResponseJson {
  return {
    ...toStatusJson(r),
    amount_charged_cents: r.amountChargedCents,
  };
}

export const installationController = {
  /** GET /catalog/installation-types — catálogo comprable. */
  async getCatalog(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const types = await installationService.getCatalog();
    await reply.code(200).send(types.map(toTypeJson));
  },

  /** GET /agents/me/installations — instalaciones compradas del agente. */
  async getMine(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rows = await installationService.getInstallations(request.agentId);
    await reply.code(200).send(rows.map(toStatusJson));
  },

  /** POST /agents/me/installations — comprar/mejorar una instalación. */
  async acquire(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = request.body as AcquireInstallationRequest;
    const result = await installationService.acquireOrUpgrade(request.agentId, {
      installationTypeKey: body.installation_type,
      expectedCurrentLevel: body.expected_current_level,
    });
    await reply.code(201).send(toAcquireResponseJson(result));
  },
};
