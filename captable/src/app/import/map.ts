import { engine } from "#shared";
import { addDecimals, decimalsEqual, multiplyDecimals, repurchasePrice, subtractDecimals } from "./decimal.ts";
import { orderCommands, type OrderableCommand } from "./order.ts";
import type {
  ImportDraft,
  ImportProblem,
  ImportReferenceRow,
  ImportWritePlan,
  OpeningBalancePreview,
  PlannedLedgerCommand,
  PlannedSecurity,
  PlannedTransaction,
  SecurityDraft,
  SourceLocation,
} from "./types.ts";

export interface MapOptions {
  asOfDate: string;
  orgId: string;
  shareUnit: string;
  currency: string;
  fileSha256: ReadonlyMap<string, string>;
}

export interface MapResult {
  plan: ImportWritePlan;
  openingBalances: OpeningBalancePreview[];
  problems: ImportProblem[];
}

const RANK = { setup: 0, issuance: 1, action: 2, opening: 3 } as const;

export function mapDraftToLedger(draft: ImportDraft, options: MapOptions): MapResult {
  const problems: ImportProblem[] = [];
  const references: ImportReferenceRow[] = [];
  const commands: OrderableCommand[] = [];
  const openingBalances: OpeningBalancePreview[] = [];
  const stakeholderIds = new Map(draft.stakeholders.map((item) => [item.sourceId, stableId(`stakeholder:${item.sourceId}`, options.orgId)]));
  const classIds = new Map(draft.shareClasses.map((item) => [item.sourceId, stableId(`class:${item.sourceId}`, options.orgId)]));
  const planIds = new Map(draft.equityPlans.map((item) => [item.sourceId, stableId(`plan:${item.sourceId}`, options.orgId)]));
  const securityIds = new Map(draft.securities.map((item) => [item.sourceId, stableId(`security:${item.sourceId}`, options.orgId)]));
  const securityBySource = new Map(draft.securities.map((item) => [item.sourceId, item]));
  const classTypeBySource = new Map(draft.shareClasses.map((item) => [item.sourceId, item.classType]));
  const terminationByStakeholder = new Map(draft.stakeholders.map((item) => [item.sourceId, item.terminationDate]));
  const securitiesByStakeholder = groupBy(draft.securities, (item) => item.stakeholderSourceId);
  const earliestGrantByPlan = new Map<string, string>();
  for (const security of draft.securities) if (security.stockPlanSourceId && security.issueDate && engine.isIsoDate(security.issueDate)) {
    const current = earliestGrantByPlan.get(security.stockPlanSourceId);
    if (!current || security.issueDate < current) earliestGrantByPlan.set(security.stockPlanSourceId, security.issueDate);
  }
  const cancellationDateBySecurity = new Map<string, string>();
  const cancellationDateBySource = new Map<string, string>();
  const creator = new Map<string, string>();
  const representedExercises = new Map<string, string>();
  const representedExerciseIds = new Set<string>();
  const representedCancellations = new Map<string, string>();
  const representedRepurchases = new Map<string, string>();
  const createdByExercise = new Set<string>();
  const vestingBySecurity = new Map(draft.vesting.map((item) => [item.securitySourceId, item]));

  references.push({
    entity: "org_profile",
    legalName: draft.companyName ?? "Imported company",
    displayName: draft.companyName ?? "Imported company",
    currency: options.currency,
    shareUnit: options.shareUnit,
    sourceId: "company",
  });
  for (const stakeholder of draft.stakeholders) {
    references.push({
      entity: "stakeholder",
      id: stakeholderIds.get(stakeholder.sourceId)!,
      displayName: stakeholder.name,
      kind: stakeholder.kind,
      relationship: stakeholder.relationship,
      email: stakeholder.email,
      sourceId: stakeholder.sourceId,
    });
  }
  for (const stockClass of draft.shareClasses) {
    if (stockClass.classType === null || stockClass.authorized === null) continue;
    references.push({ entity: "stock_class", id: classIds.get(stockClass.sourceId)!, name: stockClass.name, classType: stockClass.classType, currency: stockClass.currency, originalIssuePrice: stockClass.originalIssuePrice === null ? null : money(stockClass.originalIssuePrice, stockClass.currency), sourceId: stockClass.sourceId });
    const command = newCommand(`class:${stockClass.sourceId}`, "uploaded-class-setup", setupDate(draft, options.asOfDate), RANK.setup, stockClass.sourceId, options.orgId);
    command.transactions.push(transaction(command.id, "TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", command.effectiveDate, {
      stock_class_id: classIds.get(stockClass.sourceId)!,
      new_shares_authorized: stockClass.authorized,
      x_evidence: evidence(stockClass.source, options.fileSha256),
    }, stockClass.sourceId));
    if (stockClass.classType === "PREFERRED") {
      command.transactions.push(transaction(command.id, "TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", command.effectiveDate, {
        stock_class_id: classIds.get(stockClass.sourceId)!,
        new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: stockClass.conversionRatio!, denominator: "1" } },
        x_evidence: evidence(stockClass.source, options.fileSha256),
      }, `${stockClass.sourceId}:conversion-ratio`));
    }
    commands.push(command);
  }
  for (const plan of draft.equityPlans) {
    const stockClassId = plan.stockClassSourceId ? classIds.get(plan.stockClassSourceId) : undefined;
    if (!stockClassId) continue;
    references.push({ entity: "stock_plan", id: planIds.get(plan.sourceId)!, name: plan.name, stockClassId, effectiveDate: plan.effectiveDate, sourceId: plan.sourceId });
    const firstGrant = earliestGrantByPlan.get(plan.sourceId);
    const statedDate = plan.effectiveDate && engine.isIsoDate(plan.effectiveDate) ? plan.effectiveDate : null;
    const date = [statedDate, firstGrant, setupDate(draft, options.asOfDate)].filter((item): item is string => item !== null && item !== undefined).sort()[0]!;
    const command = newCommand(`plan:${plan.sourceId}`, "uploaded-plan-setup", date, RANK.setup, plan.sourceId, options.orgId);
    command.dependencies.push(stableId(`command:class:${plan.stockClassSourceId}`, options.orgId));
    if (plan.poolSize === null) continue;
    command.transactions.push(transaction(command.id, "TX_STOCK_PLAN_POOL_ADJUSTMENT", date, {
      stock_plan_id: planIds.get(plan.sourceId)!,
      shares_reserved: plan.poolSize,
      x_evidence: evidence(plan.source, options.fileSha256),
    }, plan.sourceId));
    command.transactions.push(transaction(command.id, "X_STOCK_PLAN_TERMS", date, {
      stock_plan_id: planIds.get(plan.sourceId)!,
      return_rules: engine.rulesToPayload(engine.DEFAULT_PLAN_RETURN_RULES),
      default_termination_windows: planTerminationWindows(plan.terminationWindowDays), default_repurchase_window: null, status: "active", pour_over_plan_id: null,
      note: "Imported current plan totals; the engine's all-RETURN defaults are recorded explicitly.", x_evidence: evidence(plan.source, options.fileSha256),
    }, `${plan.sourceId}_terms`));
    commands.push(command);
  }

  const vestingTerms = new Map<string, { id: string; sha: string }>();
  for (const schedule of draft.vesting) {
    const security = securityBySource.get(schedule.securitySourceId);
    if (!security || security.issued === null) continue;
    let definition: Extract<ImportReferenceRow, { entity: "vesting_terms" }>["definition"];
    if (schedule.definitionType === "SCHEDULE" && schedule.schedule) {
      const frequency = schedule.schedule.everyMonths === 1 ? "MONTHLY" : schedule.schedule.everyMonths === 3 ? "QUARTERLY" : schedule.schedule.everyMonths === 12 ? "ANNUALLY" : null;
      if (!frequency) continue;
      definition = { type: "SCHEDULE", totalMonths: schedule.schedule.totalMonths, frequency, cliff: schedule.schedule.cliffMonths > 0 ? { months: schedule.schedule.cliffMonths, quantityRule: "RATABLE" } : null, dayRule: "SAME_DAY_CLAMPED" };
    } else {
      if (schedule.events.length === 0 || schedule.events.some((event) => !engine.isIsoDate(event.date) || event.quantity === null || !engine.Dec.isCanonical(event.quantity) || event.quantity === "0")) continue;
      const sum = addDecimals(schedule.events.map((event) => event.quantity!));
      if (sum === null || !decimalsEqual(sum, security.issued)) continue;
      definition = { type: "EXPLICIT", events: schedule.events.map((event) => ({ date: event.date, quantity: event.quantity!, sourceId: event.sourceId.slice(0, 100), kind: event.milestone ? "EXPLICIT" : "SCHEDULED" })) };
    }
    const id = stableId(`vesting:${security.sourceId}`, options.orgId);
    const sha = engine.definitionSha256(toEngineVestingDefinition(definition));
    vestingTerms.set(security.sourceId, { id, sha });
    references.push({ entity: "vesting_terms", id, name: `${security.displayId} vesting`, definition, definitionSha256: sha, sourceId: security.sourceId });
  }

  // A dated exercise is historical only when the export names one resulting stock certificate and one tax portion.
  for (const exercise of draft.exercises) {
    const option = securityBySource.get(exercise.optionSourceId);
    const result = exercise.resultingSecuritySourceId
      ? securityBySource.get(exercise.resultingSecuritySourceId)
      : undefined;
    const onePortion = exercise.isoQuantity !== null && exercise.nsoQuantity !== null && (exercise.isoQuantity === "0") !== (exercise.nsoQuantity === "0");
    if (!option || !result || result.kind !== "stock" || !onePortion || !engine.isIsoDate(exercise.date)
      || option.issueDate === null || !engine.isIsoDate(option.issueDate) || option.issueDate > exercise.date
      || result.issued === null || exercise.quantity === null || exercise.exercisePrice === null
      || !decimalsEqual(result.issued, exercise.quantity) || (result.issueDate !== null && result.issueDate !== exercise.date)) continue;
    const optionId = securityIds.get(option.sourceId)!;
    const resultId = securityIds.get(result.sourceId)!;
    const stakeholderId = stakeholderIds.get(result.stakeholderSourceId);
    const stockClassId = result.stockClassSourceId ? classIds.get(result.stockClassSourceId) : undefined;
    if (!stakeholderId || !stockClassId) continue;
    const optionCreator = creator.get(option.sourceId) ?? stableId(`command:security:${option.sourceId}:issuance`, options.orgId);
    const command = newCommand(`exercise:${exercise.sourceId}`, "uploaded-option-exercise", exercise.date, RANK.action, exercise.sourceId, options.orgId);
    command.dependencies.push(optionCreator);
    const identity: PlannedSecurity = {
      id: resultId,
      family: "STOCK",
      subtype: classTypeBySource.get(result.stockClassSourceId ?? "") ?? "COMMON",
      stakeholderId,
      stockClassId,
      stockPlanId: option.stockPlanSourceId ? planIds.get(option.stockPlanSourceId) ?? null : null,
      displayId: result.displayId,
      parentSecurityId: optionId,
      sourceId: result.sourceId,
    };
    command.securities.push(identity);
    const portion = exercise.isoQuantity !== "0" ? "ISO" : "NSO";
    const cost = multiplyDecimals(exercise.quantity, exercise.exercisePrice);
    command.transactions.push(transaction(command.id, "TX_EQUITY_COMPENSATION_EXERCISE", exercise.date, {
      security_id: optionId,
      quantity: exercise.quantity,
      resulting_security_ids: [resultId],
      x_exercise_price: money(exercise.exercisePrice, option.currency),
      ...(cost ? { x_exercise_cost: money(cost, option.currency) } : {}),
      x_portions: [{ portion, quantity: exercise.quantity, security_id: resultId }],
      x_lots_consumed: { iso: exercise.isoQuantity!, nso: exercise.nsoQuantity! },
      ...(exercise.unvestedOnExercise !== null && exercise.unvestedOnExercise !== "0" ? { x_early_exercise: true } : {}),
      x_evidence: evidence(exercise.source, options.fileSha256),
    }, exercise.sourceId));
    const resultVesting = vestingTerms.get(result.sourceId);
    const resultSchedule = vestingBySecurity.get(result.sourceId);
    command.transactions.push(transaction(command.id, "TX_STOCK_ISSUANCE", exercise.date, stockIssuancePayload(result, resultId, stakeholderId, stockClassId, option.stockPlanSourceId ? planIds.get(option.stockPlanSourceId) ?? null : null, {
      amount: exercise.exercisePrice,
      origin: "EXERCISE",
      sourceSecurityId: optionId,
      portion,
      evidence: evidence(result.source, options.fileSha256),
      vesting: resultVesting,
    }), result.sourceId));
    if (resultVesting && resultSchedule?.startDate && engine.isIsoDate(resultSchedule.startDate)) command.transactions.push(transaction(command.id, "TX_VESTING_START", exercise.date, {
      security_id: resultId,
      x_vesting_start_date: resultSchedule.startDate,
      x_evidence: evidence(resultSchedule.source, options.fileSha256),
    }, `${result.sourceId}:vesting-start`));
    commands.push(command);
    creator.set(result.sourceId, command.id);
    createdByExercise.add(result.sourceId);
    representedExercises.set(option.sourceId, add(representedExercises.get(option.sourceId), exercise.quantity));
    representedExerciseIds.add(exercise.sourceId);
  }

  for (const stakeholder of draft.stakeholders) {
    if (!stakeholder.terminationDate || !engine.isIsoDate(stakeholder.terminationDate) || stakeholder.terminationType === null) continue;
    const stakeholderId = stakeholderIds.get(stakeholder.sourceId)!;
    const holderSecurities = securitiesByStakeholder.get(stakeholder.sourceId) ?? [];
    const affected = holderSecurities.flatMap((security) => {
      const schedule = vestingBySecurity.get(security.sourceId);
      const cancelled = schedule?.events.filter((event) => event.cancelled).map((event) => event.sourceId) ?? [];
      return cancelled.length ? [{ security_id: securityIds.get(security.sourceId)!, cancelled_vesting_event_ids: cancelled }] : [];
    });
    const command = newCommand(`termination:${stakeholder.sourceId}`, "uploaded-stakeholder-termination", stakeholder.terminationDate, RANK.action, `${stakeholder.sourceId}_termination`, options.orgId);
    for (const security of holderSecurities) {
      const dependency = creator.get(security.sourceId) ?? (security.issueDate ? stableId(`command:security:${security.sourceId}:issuance`, options.orgId) : null);
      if (dependency) command.dependencies.push(dependency);
    }
    command.transactions.push(transaction(command.id, "X_STAKEHOLDER_TERMINATION", stakeholder.terminationDate, {
      stakeholder_id: stakeholderId, termination_date: stakeholder.terminationDate, termination_type: stakeholder.terminationType,
      vesting_stop_date: stakeholder.terminationDate, relationship_before: stakeholder.relationship, relationship_after: stakeholder.relationship,
      ...(affected.length ? { securities: affected, explicit_already_applied: true } : {}), x_evidence: evidence(stakeholder.source, options.fileSha256),
    }, `${stakeholder.sourceId}_termination`));
    commands.push(command);
  }

  for (const security of draft.securities) {
    if (security.kind === "unsupported" || createdByExercise.has(security.sourceId)) continue;
    const identity = securityIdentity(security, stakeholderIds, classIds, planIds, securityIds, classTypeBySource);
    if (!identity || !validSecurityNumbers(security)) continue;
    const payload = issuancePayload(security, identity, vestingTerms.get(security.sourceId), vestingBySecurity.get(security.sourceId), terminationByStakeholder.get(security.stakeholderSourceId) ?? null, options.fileSha256, draft.sourceSystem);
    if (!payload) continue;
    if (security.issueDate && engine.isIsoDate(security.issueDate)) {
      const command = newCommand(`security:${security.sourceId}:issuance`, "uploaded-security-issuance", security.issueDate, RANK.issuance, security.sourceId, options.orgId);
      if (security.stockClassSourceId) command.dependencies.push(stableId(`command:class:${security.stockClassSourceId}`, options.orgId));
      if (security.stockPlanSourceId) command.dependencies.push(stableId(`command:plan:${security.stockPlanSourceId}`, options.orgId));
      command.securities.push(identity);
      command.transactions.push(transaction(command.id, issuanceType(security), security.issueDate, payload, security.sourceId));
      const vesting = vestingTerms.get(security.sourceId);
      const schedule = vestingBySecurity.get(security.sourceId);
      if (vesting && schedule?.startDate && engine.isIsoDate(schedule.startDate)) {
        command.transactions.push(transaction(command.id, "TX_VESTING_START", security.issueDate, {
          security_id: identity.id,
          x_vesting_start_date: schedule.startDate,
          x_evidence: evidence(schedule.source, options.fileSha256),
        }, `${security.sourceId}:vesting-start`));
      }
      commands.push(command);
      creator.set(security.sourceId, command.id);
    }
  }

  for (const cancellation of draft.cancellations) {
    const security = securityBySource.get(cancellation.securitySourceId);
    if (!security || cancellation.quantity === null || !engine.Dec.isCanonical(cancellation.quantity) || cancellation.quantity === "0") continue;
    const terminationDate = terminationByStakeholder.get(security.stakeholderSourceId);
    const cancellationDate = cancellation.date && engine.isIsoDate(cancellation.date)
      ? cancellation.date
      : terminationDate && engine.isIsoDate(terminationDate) ? terminationDate : options.asOfDate;
    cancellationDateBySource.set(cancellation.sourceId, cancellationDate);
    const lastCancellationDate = cancellationDateBySecurity.get(security.sourceId);
    if (!lastCancellationDate || cancellationDate > lastCancellationDate) cancellationDateBySecurity.set(security.sourceId, cancellationDate);
    const type = cancellationType(security);
    const securityId = securityIds.get(security.sourceId)!;
    const payload = type === "TX_CONVERTIBLE_CANCELLATION"
      ? { security_id: securityId, amount: money(cancellation.quantity, security.currency), reason_text: cancellation.reason, x_evidence: evidence(cancellation.source, options.fileSha256) }
      : type === "TX_STOCK_CANCELLATION"
        ? { security_id: securityId, quantity: cancellation.quantity, reason_text: cancellation.reason, x_evidence: evidence(cancellation.source, options.fileSha256) }
        : type === "TX_WARRANT_CANCELLATION"
          ? { security_id: securityId, quantity: cancellation.quantity, reason_text: cancellation.reason, x_reason: cancellationReason(cancellation.reason), x_evidence: evidence(cancellation.source, options.fileSha256) }
          : { security_id: securityId, quantity: cancellation.quantity, reason_text: cancellation.reason, x_reason: cancellationReason(cancellation.reason), ...(cancellation.vestingPortion ? { x_vesting_portion: cancellation.vestingPortion } : {}), x_evidence: evidence(cancellation.source, options.fileSha256) };
    const command = newCommand(`cancellation:${cancellation.sourceId}`, "uploaded-security-cancellation", cancellationDate, RANK.action, cancellation.sourceId, options.orgId);
    const dependency = creator.get(security.sourceId)
      ?? stableId(`command:security:${security.sourceId}:opening`, options.orgId);
    command.dependencies.push(dependency);
    command.transactions.push(transaction(command.id, type, cancellationDate, payload, cancellation.sourceId));
    commands.push(command);
    representedCancellations.set(security.sourceId, add(representedCancellations.get(security.sourceId), cancellation.quantity));
    if (!cancellation.date) problems.push({ severity: "warning", code: "CANCELLATION_DATE_ASSUMED", message: terminationDate && engine.isIsoDate(terminationDate) ? `${security.displayId}'s cancellation has no date, so it is recorded on the holder's termination date ${terminationDate}.` : `${security.displayId}'s cancellation has no date, so it is recorded on the selected as-of date ${options.asOfDate}.`, source: cancellation.source });
  }

  for (const security of draft.securities) {
    if (security.kind !== "stock" || security.repurchased === null || security.repurchased === "0"
      || security.repurchaseDate === null || !engine.isIsoDate(security.repurchaseDate)
      || security.repurchaseConsideration === null || !engine.Dec.isCanonical(security.repurchaseConsideration)) continue;
    const securityId = securityIds.get(security.sourceId);
    const dependency = creator.get(security.sourceId);
    const schedule = vestingBySecurity.get(security.sourceId);
    const portions = repurchasePortions(security, schedule, security.repurchaseDate, options.shareUnit);
    const resolvedPrice = repurchasePrice(security.repurchaseConsideration, security.repurchased, security.price);
    if (!securityId || !dependency || !portions || resolvedPrice === null) continue;
    const nonzeroPortions = portions.filter(([, quantity]) => quantity !== "0");
    const considerations = allocateRepurchaseConsideration(security.repurchaseConsideration, resolvedPrice.price, nonzeroPortions.map(([, quantity]) => quantity));
    if (considerations === null) continue;
    const command = newCommand(`repurchase:${security.sourceId}`, "uploaded-stock-repurchase", security.repurchaseDate, RANK.action, `${security.sourceId}_repurchase`, options.orgId);
    command.dependencies.push(dependency);
    for (const [[kind, quantity], consideration] of nonzeroPortions.map((portion, index) => [portion, considerations[index]!] as const)) {
      command.transactions.push(transaction(command.id, "TX_STOCK_REPURCHASE", security.repurchaseDate, {
        security_id: securityId,
        quantity,
        price: money(resolvedPrice.price, security.currency),
        x_kind: kind,
        x_consideration: money(consideration, security.currency),
        x_evidence: evidence(security.source, options.fileSha256),
      }, `${security.sourceId}:repurchase:${kind.toLowerCase()}`));
    }
    commands.push(command);
    representedRepurchases.set(security.sourceId, security.repurchased);
  }

  for (const security of draft.securities) {
    if (security.kind === "unsupported" || !validSecurityNumbers(security)) continue;
    const mappedExercise = representedExercises.get(security.sourceId) ?? "0";
    const mappedCancellation = representedCancellations.get(security.sourceId) ?? "0";
    const mappedRepurchase = representedRepurchases.get(security.sourceId) ?? "0";
    const needsOpening = !creator.has(security.sourceId)
      || !decimalsEqual(mappedExercise, security.exercised)
      || !decimalsEqual(mappedCancellation, security.cancelled)
      || !decimalsEqual(mappedRepurchase, security.repurchased)
      || security.transferred !== "0";
    if (!needsOpening) continue;
    const identity = securityIdentity(security, stakeholderIds, classIds, planIds, securityIds, classTypeBySource);
    if (!identity) continue;
    const issuance = issuancePayload(security, identity, vestingTerms.get(security.sourceId), vestingBySecurity.get(security.sourceId), terminationByStakeholder.get(security.stakeholderSourceId) ?? null, options.fileSha256, draft.sourceSystem);
    if (!issuance) continue;
    const unrepresentedExerciseDates = draft.exercises
      .filter((exercise) => exercise.optionSourceId === security.sourceId && !representedExerciseIds.has(exercise.sourceId) && engine.isIsoDate(exercise.date))
      .map((exercise) => exercise.date);
    const firstUnrepresentedExercise = unrepresentedExerciseDates.sort()[0];
    const firstMappedCancellation = draft.cancellations
      .filter((item) => item.securitySourceId === security.sourceId)
      .map((item) => cancellationDateBySource.get(item.sourceId))
      .filter((item): item is string => item !== undefined)
      .sort()[0];
    const openingMustPrecedeCancellation = firstUnrepresentedExercise !== undefined && firstMappedCancellation !== undefined && firstMappedCancellation <= firstUnrepresentedExercise;
    const openingDate = (draft.sourceSystem === "template" && security.exercised !== "0" || openingMustPrecedeCancellation) && security.issueDate && engine.isIsoDate(security.issueDate)
      ? security.issueDate
      : firstUnrepresentedExercise ?? options.asOfDate;
    const laterMappedCancellations = draft.cancellations.filter((item) => item.securitySourceId === security.sourceId && item.quantity !== null && engine.Dec.isCanonical(item.quantity) && (cancellationDateBySource.get(item.sourceId) ?? options.asOfDate) > openingDate);
    const laterCancellationQuantity = addDecimals(laterMappedCancellations.map((item) => item.quantity!)) ?? "0";
    const cancelledAtOpening = subtractDecimals(security.cancelled, laterCancellationQuantity) ?? security.cancelled;
    const outstandingAtOpening = addDecimals([security.outstanding, laterCancellationQuantity]) ?? security.outstanding;
    const command = newCommand(`security:${security.sourceId}:opening`, "uploaded-opening-balance", openingDate, RANK.opening, security.sourceId, options.orgId);
    if (!creator.has(security.sourceId)) {
      command.securities.push(identity);
      if (security.stockClassSourceId) command.dependencies.push(stableId(`command:class:${security.stockClassSourceId}`, options.orgId));
      if (security.stockPlanSourceId) command.dependencies.push(stableId(`command:plan:${security.stockPlanSourceId}`, options.orgId));
    }
    else command.dependencies.push(creator.get(security.sourceId)!);
    command.transactions.push(transaction(command.id, "X_MIGRATION_OPENING_BALANCE", openingDate, {
      security_id: identity.id,
      outstanding: outstandingAtOpening,
      issued: security.issued,
      ...(security.exercised !== "0" ? { exercised: security.exercised } : {}),
      ...(cancelledAtOpening !== "0" ? { cancelled: cancelledAtOpening } : {}),
      ...(!creator.has(security.sourceId) ? { issuance } : {}),
      x_evidence: evidence(security.source, options.fileSha256),
    }, `${security.sourceId}:opening`));
    commands.push(command);
    creator.set(security.sourceId, command.id);
    openingBalances.push({ securitySourceId: security.sourceId, displayId: security.displayId, date: openingDate, reason: openingReason(security, draft), source: security.source, commandId: command.id });
  }

  for (const security of draft.securities.filter((item) => item.kind === "stock")) {
    const id = securityIds.get(security.sourceId);
    if (!id || !creator.has(security.sourceId)) continue;
    references.push({
      entity: "certificate",
      id: stableId(`certificate:${security.sourceId}`, options.orgId),
      securityId: id,
      certificateNumber: security.displayId,
      issuedDate: security.issueDate && engine.isIsoDate(security.issueDate) ? security.issueDate : options.asOfDate,
      status: security.outstanding === "0" ? "CANCELLED" : "ISSUED",
      cancelledDate: security.outstanding === "0" ? cancellationDateBySecurity.get(security.sourceId) ?? options.asOfDate : null,
      sourceId: security.sourceId,
    });
  }

  const ordered = orderCommands(commands);
  problems.push(...ordered.problems);
  const sourceIds: ImportWritePlan["sourceIds"] = [
    ...draft.stakeholders.map((item) => ({ entity: "stakeholder" as const, sourceId: item.sourceId })),
    ...draft.shareClasses.map((item) => ({ entity: "stock_class" as const, sourceId: item.sourceId })),
    ...draft.equityPlans.map((item) => ({ entity: "stock_plan" as const, sourceId: item.sourceId })),
    ...draft.securities.map((item) => ({ entity: "security" as const, sourceId: item.sourceId })),
    ...draft.exercises.map((item) => ({ entity: "exercise" as const, sourceId: item.sourceId })),
    ...draft.cancellations.map((item) => ({ entity: "cancellation" as const, sourceId: item.sourceId })),
  ];
  return {
    plan: { sourceSystem: draft.sourceSystem, asOfDate: options.asOfDate, orgId: options.orgId, shareUnit: options.shareUnit, referenceRows: references, commands: ordered.commands, sourceIds },
    openingBalances,
    problems,
  };
}

function securityIdentity(
  security: SecurityDraft,
  stakeholders: ReadonlyMap<string, string>,
  classes: ReadonlyMap<string, string>,
  plans: ReadonlyMap<string, string>,
  securities: ReadonlyMap<string, string>,
  classTypes: ReadonlyMap<string, ShareClassDraftType>,
): PlannedSecurity | null {
  const stakeholderId = stakeholders.get(security.stakeholderSourceId);
  const stockClassId = security.stockClassSourceId ? classes.get(security.stockClassSourceId) : undefined;
  const stockPlanId = security.stockPlanSourceId ? plans.get(security.stockPlanSourceId) : undefined;
  if (!stakeholderId || (security.kind !== "safe" && !stockClassId) || (security.kind === "option" && !stockPlanId)) return null;
  const family = familyOf(security);
  const subtype = subtypeOf(security, classTypes);
  if (!family || !subtype) return null;
  return {
    id: securities.get(security.sourceId)!,
    family,
    subtype,
    stakeholderId,
    stockClassId: stockClassId ?? null,
    stockPlanId: stockPlanId ?? null,
    displayId: security.displayId,
    parentSecurityId: null,
    sourceId: security.sourceId,
  };
}

function issuancePayload(
  security: SecurityDraft,
  identity: PlannedSecurity,
  vesting: { id: string; sha: string } | undefined,
  schedule: ImportDraft["vesting"][number] | undefined,
  terminationDate: string | null,
  hashes: ReadonlyMap<string, string>,
  sourceSystem: ImportDraft["sourceSystem"],
): Record<string, unknown> | null {
  if (!validSecurityNumbers(security)) return null;
  const sourceEvidence = evidence(security.source, hashes);
  const vestingFields = vesting ? { vesting_terms_id: vesting.id, x_definition_sha256: vesting.sha } : {};
  const boardApprovalDisclosure = sourceSystem === "pulley" ? { x_board_approval_not_recorded_in_pulley: true as const } : {};
  switch (security.kind) {
    case "stock":
      if (security.price === null) return null;
      return stockIssuancePayload(security, identity.id, identity.stakeholderId, identity.stockClassId!, identity.stockPlanId, {
        amount: security.price,
        origin: "PURCHASE",
        evidence: sourceEvidence,
        vesting,
      });
    case "option":
      if (!security.optionType || security.price === null) return null;
      return {
        security_id: identity.id,
        custom_id: security.displayId,
        stakeholder_id: identity.stakeholderId,
        stock_plan_id: identity.stockPlanId!,
        stock_class_id: identity.stockClassId!,
        compensation_type: security.optionType === "ISO" ? "OPTION_ISO" : "OPTION_NSO",
        quantity: security.issued,
        exercise_price: money(security.price, security.currency),
        ...(security.earlyExercise === true ? { early_exercisable: true } : {}),
        expiration_date: security.expirationDate && engine.isIsoDate(security.expirationDate) ? security.expirationDate : null,
        termination_exercise_windows: terminationWindows(security, terminationDate),
        ...vestingFields,
        ...(security.fmvAtGrant ? { x_fmv: { price_per_share: money(security.fmvAtGrant, security.currency), valuation_id: null, source: "IMPORTED", source_note: sourceSystem === "pulley" ? "Pulley FMV at grant" : "Imported FMV at grant" } } : {}),
        ...boardApprovalDisclosure,
        x_evidence: sourceEvidence,
      };
    case "warrant":
      if (security.purchasePrice === null) return null;
      const totalPurchasePrice = multiplyDecimals(security.purchasePrice, security.issued) ?? security.purchasePrice;
      return {
        security_id: identity.id,
        custom_id: security.displayId,
        stakeholder_id: identity.stakeholderId,
        quantity: security.issued,
        purchase_price: money(totalPurchasePrice, security.currency),
        ...(security.price ? { exercise_price: money(security.price, security.currency) } : {}),
        ...(security.expirationDate ? { warrant_expiration_date: security.expirationDate } : {}),
        ...vestingFields,
        ...boardApprovalDisclosure,
        x_evidence: sourceEvidence,
      };
    case "safe":
      return {
        security_id: identity.id,
        custom_id: security.displayId,
        stakeholder_id: identity.stakeholderId,
        investment_amount: money(security.issued, security.currency),
        convertible_type: "SAFE",
        x_safe_terms: {
          conversion_timing: security.safeType,
          valuation_cap: security.valuationCap ? money(security.valuationCap, security.currency) : null,
          ...(security.uncapped !== null ? { uncapped: security.uncapped } : {}),
          discount_rate: security.discountRate,
        },
        ...(security.issueDate && engine.isIsoDate(security.issueDate) ? { x_funds_received_on: security.issueDate } : {}),
        ...boardApprovalDisclosure,
        x_evidence: sourceEvidence,
      };
    case "unsupported":
      return null;
  }
  void schedule;
}

function stockIssuancePayload(
  security: SecurityDraft,
  id: string,
  stakeholderId: string,
  stockClassId: string,
  stockPlanId: string | null,
  options: {
    amount: string;
    origin: "PURCHASE" | "EXERCISE";
    sourceSecurityId?: string;
    portion?: "ISO" | "NSO";
    evidence: engine.Evidence[];
    vesting?: { id: string; sha: string };
  },
): Record<string, unknown> {
  return {
    security_id: id,
    custom_id: security.displayId,
    stakeholder_id: stakeholderId,
    stock_class_id: stockClassId,
    ...(stockPlanId ? { stock_plan_id: stockPlanId } : {}),
    share_price: money(options.amount, security.currency),
    quantity: security.issued,
    ...(options.vesting ? { vesting_terms_id: options.vesting.id, x_definition_sha256: options.vesting.sha } : {}),
    x_origin: options.origin,
    ...(options.sourceSecurityId ? { x_source_security_id: options.sourceSecurityId } : {}),
    ...(options.portion ? { x_portion: options.portion } : {}),
    x_evidence: options.evidence,
  };
}

function transaction(
  commandId: string,
  type: engine.TransactionTypeCode,
  effectiveDate: string,
  payload: Record<string, unknown>,
  sourceRef: string,
): PlannedTransaction {
  const columns = engine.denormalizedColumns(payload);
  return {
    id: stableId(`tx:${commandId}:${type}:${sourceRef}`),
    type,
    effectiveDate,
    payload,
    securityId: columns.securityId,
    stakeholderId: columns.stakeholderId,
    stockClassId: columns.stockClassId,
    stockPlanId: columns.stockPlanId,
    valuationId: columns.valuationId,
    quantity: columns.quantity,
    amount: columns.amount,
    currency: columns.currency,
    payloadVersion: 1,
    sourceRef: refKey(sourceRef).slice(0, 128),
  };
}

function newCommand(label: string, type: string, effectiveDate: string, rank: number, sourceId: string, orgId: string): OrderableCommand {
  const id = stableId(`command:${label}`, orgId);
  return { id, idempotencyKey: `import:${safeKey(label)}`, type, effectiveDate, securities: [], transactions: [], dependencies: [], sourceId, rank };
}

function evidence(source: SourceLocation, hashes: ReadonlyMap<string, string>): engine.Evidence[] {
  return [{ run: "spreadsheet-import", file: source.file, pointer: `${source.sheet}!${source.row}`, sha256: hashes.get(source.file) ?? engine.sha256Hex(""), kind: "spreadsheet" }];
}

function money(amount: string, currency: string): { amount: string; currency: string } {
  return { amount, currency };
}

function issuanceType(security: SecurityDraft): engine.TransactionTypeCode {
  return security.kind === "stock" ? "TX_STOCK_ISSUANCE"
    : security.kind === "option" ? "TX_EQUITY_COMPENSATION_ISSUANCE"
      : security.kind === "warrant" ? "TX_WARRANT_ISSUANCE"
        : "TX_CONVERTIBLE_ISSUANCE";
}

function cancellationType(security: SecurityDraft): engine.TransactionTypeCode {
  return security.kind === "stock" ? "TX_STOCK_CANCELLATION"
    : security.kind === "option" ? "TX_EQUITY_COMPENSATION_CANCELLATION"
      : security.kind === "warrant" ? "TX_WARRANT_CANCELLATION"
        : "TX_CONVERTIBLE_CANCELLATION";
}

function familyOf(security: SecurityDraft): engine.SecurityFamily | null {
  return security.kind === "stock" ? "STOCK"
    : security.kind === "option" ? "EQUITY_COMPENSATION"
      : security.kind === "warrant" ? "WARRANT"
        : security.kind === "safe" ? "CONVERTIBLE" : null;
}

type ShareClassDraftType = ImportDraft["shareClasses"][number]["classType"];
function subtypeOf(security: SecurityDraft, classTypes: ReadonlyMap<string, ShareClassDraftType>): engine.SecuritySubtype | null {
  if (security.kind === "stock") return classTypes.get(security.stockClassSourceId ?? "") ?? null;
  if (security.kind === "option") return security.optionType === "ISO" ? "OPTION_ISO" : security.optionType === "NSO" ? "OPTION_NSO" : null;
  if (security.kind === "warrant") return "WARRANT";
  if (security.kind === "safe") return "SAFE";
  return null;
}

function repurchasePortions(
  security: SecurityDraft,
  schedule: ImportDraft["vesting"][number] | undefined,
  date: string,
  shareUnit: string,
): Array<["UNVESTED" | "VESTED", string]> | null {
  if (security.issued === null || security.repurchased === null || !engine.Dec.isCanonical(security.issued) || !engine.Dec.isCanonical(security.repurchased)) return null;
  const issued = engine.Dec.parse(security.issued);
  let vested = issued;
  if (schedule) {
    if (schedule.definitionType === "EXPLICIT") {
      const active = schedule.events.filter((event) => !event.cancelled && event.date <= date && event.quantity !== null && engine.Dec.isCanonical(event.quantity));
      vested = engine.Dec.min(issued, engine.Dec.sum(active.map((event) => engine.Dec.parse(event.quantity!))));
    } else {
      if (!schedule.schedule || !schedule.startDate || !engine.isIsoDate(schedule.startDate)) return null;
      const frequency = schedule.schedule.everyMonths === 1 ? "MONTHLY" : schedule.schedule.everyMonths === 3 ? "QUARTERLY" : schedule.schedule.everyMonths === 12 ? "ANNUALLY" : null;
      if (frequency === null) return null;
      const definition: engine.ScheduleDefinition = {
        type: "SCHEDULE",
        totalMonths: schedule.schedule.totalMonths,
        frequency,
        cliff: schedule.schedule.cliffMonths > 0 ? { months: schedule.schedule.cliffMonths, quantityRule: "RATABLE" } : null,
        dayRule: "SAME_DAY_CLAMPED",
      };
      vested = engine.Dec.sum(engine.generateSchedule(definition, issued, schedule.startDate, shareUnit).filter((event) => event.date <= date).map((event) => event.quantity));
    }
  }
  const total = engine.Dec.parse(security.repurchased);
  const unvested = issued.sub(vested).clampZero();
  const unvestedPart = engine.Dec.min(total, unvested);
  return [["UNVESTED", unvestedPart.toCanonical()], ["VESTED", total.sub(unvestedPart).toCanonical()]];
}

function allocateRepurchaseConsideration(total: string, price: string, quantities: readonly string[]): string[] | null {
  try {
    let remaining = engine.Dec.parse(total);
    return quantities.map((quantity, index) => {
      if (index === quantities.length - 1) return remaining.toCanonical();
      const extended = engine.Rational.fromDec(price).mul(quantity).roundTo(2, "HALF_EVEN");
      const allocated = engine.Dec.min(extended, remaining);
      remaining = remaining.sub(allocated);
      return allocated.toCanonical();
    });
  } catch {
    return null;
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) { const value = key(item); const bucket = grouped.get(value); if (bucket) bucket.push(item); else grouped.set(value, [item]); }
  return grouped;
}

function cancellationReason(reason: string): engine.CancellationReason {
  if (/terminat/i.test(reason)) return "TERMINATION";
  if (/expir/i.test(reason)) return "EXPIRED";
  if (/forfeit/i.test(reason)) return "FORFEITURE_UNDER_AGREEMENT";
  return "OTHER";
}

function openingReason(security: SecurityDraft, draft: ImportDraft): string {
  const source = draft.sourceSystem === "pulley" ? "Pulley export" : "spreadsheet";
  if (!security.issueDate || !engine.isIsoDate(security.issueDate)) return `The ${source} does not give this security a reliable issue date.`;
  if (security.repurchased !== "0" || security.transferred !== "0" || /(TRANSFER|REPURCHASE|CONVERT)/i.test(security.status)) return `The ${source} states the current consumed balance but does not identify every resulting or balance lot.`;
  if (security.exercised !== "0" && !draft.exercises.some((exercise) => exercise.optionSourceId === security.sourceId && exercise.resultingSecuritySourceId)) {
    return draft.sourceSystem === "pulley"
      ? "The exercise report does not identify exactly one resulting share certificate, so the current exercised amount is an opening balance."
      : "The spreadsheet states an exercised amount without dated exercise transactions, so that amount is an opening balance.";
  }
  if (security.cancelled !== "0" && !draft.cancellations.some((cancellation) => cancellation.securitySourceId === security.sourceId && cancellation.date)) {
    return "Pulley reports a cancelled amount without a cancellation date.";
  }
  return `The ${source} states the current position but does not prove every earlier transaction.`;
}

function setupDate(draft: ImportDraft, fallback: string): string {
  const dates = [
    ...draft.securities.map((item) => item.issueDate),
    ...draft.equityPlans.map((item) => item.effectiveDate),
    ...draft.exercises.map((item) => item.date),
  ].filter((date): date is string => date !== null && engine.isIsoDate(date));
  return dates.length > 0 ? dates.sort()[0]! : fallback;
}

function validSecurityNumbers(security: SecurityDraft): security is SecurityDraft & { issued: string; outstanding: string; exercised: string; cancelled: string; repurchased: string; transferred: string } {
  return [security.issued, security.outstanding, security.exercised, security.cancelled, security.repurchased, security.transferred].every((value) => value !== null && engine.Dec.isCanonical(value))
    && security.issued !== "0";
}

function add(current: string | undefined, amount: string): string {
  return addDecimals([current ?? "0", amount]) ?? current ?? "0";
}

function stableId(label: string, orgId?: string): string {
  const hex = engine.sha256Hex(`uploaded-import:${orgId ?? "source-neutral"}:${label}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function safeKey(label: string): string {
  return label.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 190);
}

function refKey(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe.length <= 100 ? safe : `${safe.slice(0, 75)}_${engine.sha256Hex(label).slice(0, 20)}`;
}

function terminationWindows(security: SecurityDraft, terminationDate: string | null): Array<{ reason: "VOLUNTARY_OTHER"; period: number; period_type: "DAYS" }> {
  if (!security.exerciseDeadline || !terminationDate || !engine.isIsoDate(terminationDate) || !engine.isIsoDate(security.exerciseDeadline)) return [];
  return [{ reason: "VOLUNTARY_OTHER", period: Math.max(0, Math.round((Date.parse(`${security.exerciseDeadline}T00:00:00Z`) - Date.parse(`${terminationDate}T00:00:00Z`)) / 86_400_000)), period_type: "DAYS" }];
}

function planTerminationWindows(days: number | null): engine.TerminationWindow[] {
  if (days === null) return [];
  return ["VOLUNTARY_OTHER", "VOLUNTARY_GOOD_CAUSE", "VOLUNTARY_RETIREMENT", "INVOLUNTARY_OTHER", "INVOLUNTARY_DEATH", "INVOLUNTARY_DISABILITY", "INVOLUNTARY_WITH_CAUSE"].map((reason) => ({ reason, period: days, period_type: "DAYS" as const })) as engine.TerminationWindow[];
}

export function replayPlan(plan: ImportWritePlan): { state: engine.LedgerState; metrics: engine.CapTableMetrics } {
  const stakeholders: engine.StakeholderRef[] = plan.referenceRows
    .filter((row): row is Extract<ImportReferenceRow, { entity: "stakeholder" }> => row.entity === "stakeholder")
    .map((row) => ({ id: row.id, relationship: row.relationship, kind: row.kind }));
  const stockClasses: engine.StockClassRef[] = plan.referenceRows
    .filter((row): row is Extract<ImportReferenceRow, { entity: "stock_class" }> => row.entity === "stock_class")
    .map((row) => ({ id: row.id, name: row.name, classType: row.classType }));
  const stockPlans: engine.StockPlanRef[] = plan.referenceRows
    .filter((row): row is Extract<ImportReferenceRow, { entity: "stock_plan" }> => row.entity === "stock_plan")
    .map((row) => ({ id: row.id, name: row.name, stockClassId: row.stockClassId }));
  const vestingTerms: engine.VestingTermsRef[] = plan.referenceRows
    .filter((row): row is Extract<ImportReferenceRow, { entity: "vesting_terms" }> => row.entity === "vesting_terms")
    .map((row) => ({ id: row.id, definition: toEngineVestingDefinition(row.definition), definitionSha256: row.definitionSha256 }));
  const securities: engine.SecurityIdentity[] = plan.commands.flatMap((command) => command.securities.map((security) => ({
    id: security.id,
    family: security.family,
    subtype: security.subtype,
    stakeholderId: security.stakeholderId,
    stockClassId: security.stockClassId,
    stockPlanId: security.stockPlanId,
    displayId: security.displayId,
    parentSecurityId: security.parentSecurityId,
    originCommandId: command.id,
  })));
  const commands: engine.LedgerCommand[] = [];
  const transactions: engine.LedgerTransaction[] = [];
  let seq = 0;
  for (const command of plan.commands) {
    const firstSeq = seq + 1;
    for (const tx of command.transactions) {
      seq += 1;
      transactions.push(engine.decodeTransaction({
        id: tx.id,
        seq,
        commandId: command.id,
        type: tx.type,
        effectiveDate: tx.effectiveDate,
        payload: tx.payload,
        securityId: tx.securityId,
        stakeholderId: tx.stakeholderId,
        stockClassId: tx.stockClassId,
        stockPlanId: tx.stockPlanId,
        valuationId: tx.valuationId,
        quantity: tx.quantity,
        amount: tx.amount,
        currency: tx.currency,
        payloadVersion: tx.payloadVersion,
        source: "import",
      }));
    }
    commands.push({ id: command.id, type: command.type, actorKind: "import", reversesCommandId: null, firstSeq, lastSeq: seq, declaredTxCount: command.transactions.length, createdAt: firstSeq });
  }
  const reference: engine.EngineReference = { orgId: plan.orgId, shareUnit: plan.shareUnit, securities, stockClasses, stockPlans, stakeholders, vestingTerms, commands };
  const state = engine.replay(reference, transactions, { asOf: plan.asOfDate });
  return { state, metrics: engine.computeMetrics(state) };
}

export function toEngineVestingDefinition(definition: Extract<ImportReferenceRow, { entity: "vesting_terms" }>["definition"]): engine.VestingDefinition {
  return definition.type === "SCHEDULE" ? definition : {
    type: "EXPLICIT",
    events: definition.events.map((event) => ({ date: event.date, quantity: event.quantity, pulleyId: event.sourceId, kind: event.kind })),
  };
}
