'use client';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { quarterDisplayNames } from '../../../helpers/planner';
import { deepCopy, useIsMobile, pluralize } from '../../../helpers/util';
import { useAppDispatch, useAppSelector } from '../../../store/hooks';
import {
  createQuarterCourseLoadingPlaceholder,
  reviseRoadmap,
  selectCurrentPlan,
  setActiveCourse,
  showMobileCatalog,
} from '../../../store/slices/roadmapSlice';
import {
  CourseIdentifier,
  getSlotCourses,
  getSlotUnits,
  InvalidCourseData,
  PlannerQuarterData,
  QuarterSlot,
} from '../../../types/types';
import './Quarter.scss';

import Course from './Course';
import { ReactSortable, SortableEvent } from 'react-sortablejs';
import { quarterSortable } from '../../../helpers/sortable';

import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { Button, Card, IconButton } from '@mui/material';
import {
  mergeSlotWithDraggedCourse,
  ModifiedQuarter,
  modifyQuarterCourse,
  moveQuarterSlot,
  reorderQuarterCourse,
  removeAbChoiceSub,
  removeFromSourceAndReplaceAbChoiceSub,
  removeFromSourceAndReplaceSlotWithAbChoice,
  replaceAbChoiceSub,
  replaceSlotWithAbChoice,
  splitAbChoiceIntoSingles,
  swapAbChoiceInSlot,
  swapAbChoiceSubWithSlot,
} from '../../../helpers/roadmapEdits';

interface QuarterProps {
  yearIndex: number;
  quarterIndex: number;
  data: PlannerQuarterData;
}

// How long to hover over a course center to enter A/B state (ms)
const AB_HOLD_MS = 400;
// When adding from elsewhere: middle 80% = A/B zone; top/bottom 10% each
const CENTER_ZONE_ADD = { min: 0.1, max: 0.9 };
// When reordering within quarter: middle 60% = A/B zone; top/bottom 20% each (easier to hold)
const CENTER_ZONE_REORDER = { min: 0.2, max: 0.8 };
// Delay before reorder is allowed (ms): 200 when adding, 135 when reordering
const REORDER_DELAY_ADD_MS = 200;
const REORDER_DELAY_REORDER_MS = 135;

// Shared: true only while mouse/touch is physically pressed (button down or finger on screen)
const isPointerDownRef = { current: false };

/** Per-quarter handlers for 4-dot split; key = "yearIndex-quarterIndex" */
const splitAbHandlersRef = {
  current: {} as Record<string, (slotIndex: number) => void>,
};

// slot for a course in a quarter (single or A/B choice)
// isAbTargetSub: when A/B slot, 0 = shrink left only, 1 = shrink right only; null = shrink both (single-slot target)
interface QuarterCourseSlotProps {
  slot: QuarterSlot;
  index: number;
  yearIndex: number;
  quarterIndex: number;
  invalidCourses: InvalidCourseData[];
  removeCourseAt: (index: number) => void;
  removeAbSubAt?: (index: number, subIndex: 0 | 1) => void;
  onSwapAbAt?: (index: number) => void;
  isAbTarget?: boolean;
  isAbTargetSub?: 0 | 1 | null;
}

const QuarterCourseSlot: FC<QuarterCourseSlotProps> = ({
  slot,
  index,
  yearIndex,
  quarterIndex,
  invalidCourses,
  removeCourseAt,
  removeAbSubAt,
  onSwapAbAt,
  isAbTarget = false,
  isAbTargetSub = null,
}) => {
  let requiredCourses: string[] = null!;
  invalidCourses.forEach((ic) => {
    const loc = ic.location;
    if (loc.courseIndex === index && loc.quarterIndex === quarterIndex && loc.yearIndex === yearIndex) {
      requiredCourses = ic.required;
    }
  });

  const isAb = slot.type === 'ab';
  const targetClass =
    isAbTarget && isAb
      ? isAbTargetSub === 0
        ? 'quarter-course-slot--ab-target-left'
        : isAbTargetSub === 1
          ? 'quarter-course-slot--ab-target-right'
          : 'quarter-course-slot--ab-target'
      : isAbTarget
        ? 'quarter-course-slot--ab-target'
        : '';

  const abGhostMaxUnits = isAb ? getSlotUnits(slot) : 0;

  return (
    <div className={`quarter-course-slot ${isAb ? 'quarter-course-slot--ab' : ''} ${targetClass}`}>
      {isAb ? (
        <>
          <div className="quarter-course-slot__ab-ghost-label quarter-course-slot__ab-ghost-card">
            <div className="course-drag-handle">
              <DragIndicatorIcon />
            </div>
            <div className="quarter-course-slot__ab-ghost-card-top">
              <div className="quarter-course-slot__ab-ghost-names">
                <span className="name">
                  {slot.a.department} {slot.a.courseNumber}
                </span>
                <span className="name">
                  {slot.b.department} {slot.b.courseNumber}
                </span>
              </div>
              <span className="units">
                {abGhostMaxUnits} unit{pluralize(abGhostMaxUnits)}
              </span>
              <IconButton className="course-delete-btn" aria-hidden tabIndex={-1} size="small">
                <DeleteOutlineIcon className="course-delete-icon" />
              </IconButton>
            </div>
          </div>
          <div className="quarter-course-slot__half quarter-course-slot__half--a">
            <Course
              key="a"
              data={slot.a}
              requiredCourses={requiredCourses}
              onDelete={removeAbSubAt ? () => removeAbSubAt(index, 0) : () => removeCourseAt(index)}
              dragVariant="normal"
              addMode="drag"
              openPopoverLeft
            />
          </div>
          <div
            className={`ab-or-divider ${onSwapAbAt ? 'ab-or-divider--swappable' : ''}`}
            role={onSwapAbAt ? 'button' : undefined}
            tabIndex={onSwapAbAt ? 0 : undefined}
            onClick={
              onSwapAbAt
                ? (e) => {
                    e.stopPropagation();
                    onSwapAbAt(index);
                  }
                : undefined
            }
            onKeyDown={
              onSwapAbAt
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSwapAbAt(index);
                    }
                  }
                : undefined
            }
            aria-label={onSwapAbAt ? 'Swap courses' : undefined}
          >
            <span className="ab-or-divider__text">or</span>
            {onSwapAbAt && <SwapHorizIcon className="ab-or-divider__swap" fontSize="small" />}
          </div>
          <div className="quarter-course-slot__half quarter-course-slot__half--b">
            <Course
              key="b"
              data={slot.b}
              requiredCourses={requiredCourses}
              onDelete={removeAbSubAt ? () => removeAbSubAt(index, 1) : () => removeCourseAt(index)}
              dragVariant="mini-right"
              addMode="drag"
              openPopoverLeft
            />
          </div>
        </>
      ) : (
        <Course
          key={index}
          data={slot.course}
          requiredCourses={requiredCourses}
          onDelete={() => removeCourseAt(index)}
          addMode="drag"
          openPopoverLeft
        />
      )}
    </div>
  );
};

const Quarter: FC<QuarterProps> = ({ yearIndex, quarterIndex, data }) => {
  const dispatch = useAppDispatch();
  const quarterTitle = quarterDisplayNames[data.name];
  const invalidCourses = useAppSelector(
    (state) => state.roadmap.plans[state.roadmap.currentPlanIndex].content.invalidCourses,
  );
  const quarterContainerRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [moveCourseTrigger, setMoveCourseTrigger] = useState<CourseIdentifier | null>(null);
  const activeCourseLoading = useAppSelector((state) => state.roadmap.activeCourseLoading);
  const activeCourse = useAppSelector((state) => state.roadmap.activeCourse);
  const activeCourseDraggedFrom = useAppSelector((state) => state.roadmap.activeCourseDragSource);
  const showAddCourse = useAppSelector((state) => state.roadmap.showAddCourse);
  const isDragging = activeCourse !== null;

  // Only run A/B when physically dragging (AddCoursePopup clears activeCourse on close to avoid shrink-on-hover)
  const isPhysicalDrag = isDragging && !showAddCourse;
  const currentPlan = useAppSelector(selectCurrentPlan);
  const startYear = currentPlan.content.yearPlans[yearIndex].startYear;
  const isReorderingWithinQuarter =
    activeCourseDraggedFrom !== null &&
    activeCourseDraggedFrom.startYear === startYear &&
    activeCourseDraggedFrom.quarter?.name === data.name;

  const isDraggingAbSlot =
    activeCourseDraggedFrom?.quarter != null &&
    typeof activeCourseDraggedFrom.courseIndex === 'number' &&
    activeCourseDraggedFrom.quarter.courses[activeCourseDraggedFrom.courseIndex]?.type === 'ab';

  // The confirmed A/B target: slot index and, for A/B slots, which half (0=left, 1=right; null=whole slot)
  const [abTargetSlotIndex, setAbTargetSlotIndex] = useState<number | null>(null);
  const [abTargetSubIndex, setAbTargetSubIndex] = useState<0 | 1 | null>(null);
  const abTargetSlotIndexRef = useRef<number | null>(null);
  const abTargetSubIndexRef = useRef<0 | 1 | null>(null);
  abTargetSlotIndexRef.current = abTargetSlotIndex;
  abTargetSubIndexRef.current = abTargetSubIndex;

  // Refs to each slot element
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);

  // 4-dot press: split A|B into two single slots; prevents Sortable from starting a drag on the A|B slot
  useEffect(() => {
    const key = `${yearIndex}-${quarterIndex}`;
    splitAbHandlersRef.current[key] = (slotIndex: number) => {
      const revision = splitAbChoiceIntoSingles(currentPlan.id, startYear, data, slotIndex);
      dispatch(reviseRoadmap(revision));
    };
    return () => {
      delete splitAbHandlersRef.current[key];
    };
  }, [currentPlan.id, data, dispatch, startYear, yearIndex, quarterIndex]);

  useEffect(() => {
    const onPointerDownCapture = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('.course-drag-handle--mini-right')) {
        const wrapper = target.closest?.('.quarter-course-slot-wrapper') as HTMLElement | null;
        const quarter = wrapper?.closest?.('.quarter[data-year-index][data-quarter-index]') as HTMLElement | null;
        if (wrapper && quarter) {
          const yi = parseInt(quarter.getAttribute('data-year-index') ?? '', 10);
          const qi = parseInt(quarter.getAttribute('data-quarter-index') ?? '', 10);
          const slotIndex = parseInt(wrapper.getAttribute('data-slot-index') ?? '', 10);
          if (!isNaN(yi) && !isNaN(qi) && !isNaN(slotIndex)) {
            const handler = splitAbHandlersRef.current[`${yi}-${qi}`];
            handler?.(slotIndex);
            e.preventDefault();
            e.stopPropagation();
            // After split, B is at slotIndex+1; programmatically start drag on B so user keeps holding it
            const clientX = 'touches' in e ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX;
            const clientY = 'touches' in e ? (e as TouchEvent).touches[0].clientY : (e as MouseEvent).clientY;
            const isTouch = 'touches' in e;
            setTimeout(() => {
              const list = document.querySelector(
                `.quarter[data-year-index="${yi}"][data-quarter-index="${qi}"] .quarter-course-list`,
              );
              const wrappers = list?.querySelectorAll('.quarter-course-slot-wrapper');
              const bWrapper = wrappers?.[slotIndex + 1] as HTMLElement | undefined;
              const handle = bWrapper?.querySelector('.course-drag-handle') as HTMLElement | null;
              if (handle) {
                if (isTouch) {
                  const touch = new Touch({
                    identifier: Date.now(),
                    target: handle,
                    clientX,
                    clientY,
                    radiusX: 0,
                    radiusY: 0,
                    rotationAngle: 0,
                    force: 1,
                  });
                  handle.dispatchEvent(
                    new TouchEvent('touchstart', {
                      cancelable: true,
                      bubbles: true,
                      touches: [touch],
                      targetTouches: [touch],
                      changedTouches: [touch],
                    }),
                  );
                } else {
                  handle.dispatchEvent(
                    new MouseEvent('mousedown', {
                      bubbles: true,
                      cancelable: true,
                      view: window,
                      clientX,
                      clientY,
                      button: 0,
                      buttons: 1,
                    }),
                  );
                }
              }
            }, 0);
          }
        }
      }
    };
    document.addEventListener('mousedown', onPointerDownCapture, true);
    document.addEventListener('touchstart', onPointerDownCapture, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDownCapture, true);
      document.removeEventListener('touchstart', onPointerDownCapture, true);
    };
  }, []);

  // Timer used to detect whether the user has hovered a slot long enough to trigger A/B event
  const abTargetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Slot index and sub (for A/B) to verify we are still hovering over the same target
  const pendingAbTargetIndexRef = useRef<number | null>(null);
  const pendingAbTargetSubRef = useRef<0 | 1 | null>(null);

  // Last pointer position for use in Sortable onMove
  const pointerPosRef = useRef({ x: 0, y: 0 });
  const reorderAllowedRef = useRef(false);
  const reorderDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const calculateQuarterStats = () => {
    let unitCount = 0;
    let slotCount = 0;
    data.courses.forEach((slot) => {
      unitCount += getSlotUnits(slot);
      slotCount += 1;
    });
    return [unitCount, slotCount];
  };

  const unitCount = calculateQuarterStats()[0];

  const coursesCopy = deepCopy(data.courses); // Sortable requires data to be extensible (non read-only)

  const removeCourseAt = useCallback(
    (index: number) => {
      const quarterToRemove = { startYear, quarter: data, courseIndex: index };
      const slot = data.courses[index];
      const courseForRemove = getSlotCourses(slot)[0];
      const revision = modifyQuarterCourse(currentPlan.id, courseForRemove, quarterToRemove, null);
      dispatch(reviseRoadmap(revision));
    },
    [currentPlan.id, data, dispatch, startYear],
  );

  const removeAbSubAt = useCallback(
    (index: number, subIndex: 0 | 1) => {
      const revision = removeAbChoiceSub(currentPlan.id, startYear, data, index, subIndex);
      dispatch(reviseRoadmap(revision));
    },
    [currentPlan.id, data, dispatch, startYear],
  );

  const swapAbAt = useCallback(
    (index: number) => {
      const revision = swapAbChoiceInSlot(currentPlan.id, startYear, data, index);
      dispatch(reviseRoadmap(revision));
    },
    [currentPlan.id, data, dispatch, startYear],
  );

  // While dragging, track pointer and prime A/B when held over a slot's center
  useEffect(() => {
    if (!isPhysicalDrag) {
      if (abTargetTimerRef.current) {
        clearTimeout(abTargetTimerRef.current);
        abTargetTimerRef.current = null;
      }
      if (reorderDelayTimerRef.current) {
        clearTimeout(reorderDelayTimerRef.current);
        reorderDelayTimerRef.current = null;
      }
      pendingAbTargetIndexRef.current = null;
      pendingAbTargetSubRef.current = null;
      reorderAllowedRef.current = false;
      setAbTargetSlotIndex(null);
      setAbTargetSubIndex(null);
      return;
    }

    const clearTimer = () => {
      if (abTargetTimerRef.current) {
        clearTimeout(abTargetTimerRef.current);
        abTargetTimerRef.current = null;
      }
      pendingAbTargetIndexRef.current = null;
      pendingAbTargetSubRef.current = null;
    };
    const clearReorderDelay = () => {
      if (reorderDelayTimerRef.current) {
        clearTimeout(reorderDelayTimerRef.current);
        reorderDelayTimerRef.current = null;
      }
      reorderAllowedRef.current = false;
    };

    const centerZone = isReorderingWithinQuarter ? CENTER_ZONE_REORDER : CENTER_ZONE_ADD;
    const reorderDelayMs = isReorderingWithinQuarter ? REORDER_DELAY_REORDER_MS : REORDER_DELAY_ADD_MS;
    const draggedIndex =
      isReorderingWithinQuarter && activeCourseDraggedFrom?.courseIndex != null
        ? activeCourseDraggedFrom.courseIndex
        : -1;

    const checkPointer = (clientX: number, clientY: number) => {
      if (!isPointerDownRef.current) return; // only run while actually holding
      if (isDraggingAbSlot) {
        // Never show A/B target or run merge logic when dragging an A/B slot
        clearTimer();
        setAbTargetSlotIndex(null);
        setAbTargetSubIndex(null);
        return;
      }
      const n = data.courses.length;
      let foundCenterIndex: number | null = null;
      let foundSubIndex: 0 | 1 | null = null;
      for (let i = 0; i < n; i++) {
        if (i === draggedIndex) continue; // don't A/B with ourselves
        const el = slotRefs.current[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
        const relY = (clientY - rect.top) / rect.height;
        if (relY >= centerZone.min && relY <= centerZone.max) {
          foundCenterIndex = i;
          const slot = data.courses[i];
          if (slot.type === 'ab') {
            const relX = (clientX - rect.left) / rect.width;
            foundSubIndex = relX < 0.5 ? 0 : 1;
          }
          break;
        }
      }

      if (foundCenterIndex !== null) {
        clearReorderDelay();
        const pendingMismatch =
          pendingAbTargetIndexRef.current !== foundCenterIndex ||
          (data.courses[foundCenterIndex].type === 'ab' && pendingAbTargetSubRef.current !== foundSubIndex);
        if (pendingMismatch) {
          clearTimer();
          pendingAbTargetIndexRef.current = foundCenterIndex;
          pendingAbTargetSubRef.current = foundSubIndex;

          abTargetTimerRef.current = setTimeout(() => {
            abTargetTimerRef.current = null;
            pendingAbTargetIndexRef.current = null;
            setAbTargetSlotIndex(foundCenterIndex!);
            setAbTargetSubIndex(foundSubIndex);
          }, AB_HOLD_MS);
        }
      } else {
        clearTimer();
        setAbTargetSlotIndex(null);
        setAbTargetSubIndex(null);
        // Track reorder zone: if in top/bottom (not center), start delay timer
        const inReorderZone = (() => {
          for (let i = 0; i < data.courses.length; i++) {
            if (i === draggedIndex) continue;
            const el = slotRefs.current[i];
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
            const relY = (clientY - rect.top) / rect.height;
            if (relY < centerZone.min || relY > centerZone.max) return true;
            return false;
          }
          return false;
        })();
        if (inReorderZone) {
          if (!reorderDelayTimerRef.current) {
            reorderDelayTimerRef.current = setTimeout(() => {
              reorderDelayTimerRef.current = null;
              reorderAllowedRef.current = true;
            }, reorderDelayMs);
          }
        } else {
          clearReorderDelay();
        }
      }
    };

    const onPointerMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0]?.clientY : e.clientY;
      if (clientX == null || clientY == null) return;
      pointerPosRef.current = { x: clientX, y: clientY };
      checkPointer(clientX, clientY);
    };

    const onPointerDown = () => {
      isPointerDownRef.current = true;
    };
    const onPointerUp = () => {
      isPointerDownRef.current = false;
      clearTimer();
      clearReorderDelay();
      setAbTargetSlotIndex(null);
      setAbTargetSubIndex(null);
    };

    isPointerDownRef.current = true; // we're in a drag, so button must be down
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('touchmove', onPointerMove, { passive: true });
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('touchend', onPointerUp);

    return () => {
      isPointerDownRef.current = false;
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('mousemove', onPointerMove);
      document.removeEventListener('touchmove', onPointerMove);
      document.removeEventListener('mouseup', onPointerUp);
      document.removeEventListener('touchend', onPointerUp);
      clearTimer();
      clearReorderDelay();
    };
  }, [
    dispatch,
    isPhysicalDrag,
    data.courses,
    isReorderingWithinQuarter,
    activeCourseDraggedFrom?.courseIndex,
    isDraggingAbSlot,
  ]);

  const handleSortableMove = useCallback(() => {
    if (isDraggingAbSlot) return true; // never block or merge when dragging A/B slot
    const centerZone = isReorderingWithinQuarter ? CENTER_ZONE_REORDER : CENTER_ZONE_ADD;
    const { x: clientX, y: clientY } = pointerPosRef.current;
    const n = data.courses.length;
    const draggedIdx =
      isReorderingWithinQuarter && activeCourseDraggedFrom?.courseIndex != null
        ? activeCourseDraggedFrom.courseIndex
        : -1;
    for (let i = 0; i < n; i++) {
      if (i === draggedIdx) continue;
      const el = slotRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      const relY = (clientY - rect.top) / rect.height;
      if (relY >= centerZone.min && relY <= centerZone.max) return false;
      return reorderAllowedRef.current; // top/bottom zone → allow only after delay
    }
    return true; // not over any slot → allow default behavior
  }, [data.courses.length, isReorderingWithinQuarter, activeCourseDraggedFrom?.courseIndex, isDraggingAbSlot]);

  const addCourse = async (event: SortableEvent) => {
    const targetIndex = abTargetSlotIndexRef.current;
    const targetSubIndex = abTargetSubIndexRef.current;
    const sourceQuarter = (activeCourseDraggedFrom ?? null) as ModifiedQuarter | null;
    if (targetIndex !== null && targetIndex !== undefined && !activeCourseLoading && activeCourse) {
      const targetSlot = data.courses[targetIndex];
      if (targetSlot.type === 'ab' && targetSubIndex !== null && targetSubIndex !== undefined) {
        if (sourceQuarter) {
          const revision = removeFromSourceAndReplaceAbChoiceSub(
            currentPlan.id,
            sourceQuarter,
            data,
            startYear,
            targetIndex,
            targetSubIndex,
            activeCourse,
          );
          dispatch(reviseRoadmap(revision));
        } else {
          const revision = replaceAbChoiceSub(
            currentPlan.id,
            startYear,
            data,
            targetIndex,
            targetSubIndex,
            activeCourse,
          );
          dispatch(reviseRoadmap(revision));
        }
        dispatch(setActiveCourse(null));
        return;
      }
      const existingCourse = getSlotCourses(targetSlot)[0];
      if (sourceQuarter) {
        const revision = removeFromSourceAndReplaceSlotWithAbChoice(
          currentPlan.id,
          sourceQuarter,
          data,
          startYear,
          targetIndex,
          existingCourse,
          activeCourse,
        );
        dispatch(reviseRoadmap(revision));
      } else {
        const revision = replaceSlotWithAbChoice(
          currentPlan.id,
          startYear,
          data,
          targetIndex,
          existingCourse,
          activeCourse,
        );
        dispatch(reviseRoadmap(revision));
      }
      dispatch(setActiveCourse(null));
      return;
    }

    const target = { yearIndex, quarterIndex, courseIndex: event.newIndex! };
    if (activeCourseLoading) {
      dispatch(createQuarterCourseLoadingPlaceholder(target));
      setMoveCourseTrigger(target);
      return;
    }

    // If the course is being dragged from another quarter in the roadmap
    if (sourceQuarter) {
      const movedSlot = sourceQuarter.quarter.courses[sourceQuarter.courseIndex];
      if (movedSlot) {
        const addToQuarter: ModifiedQuarter = {
          startYear,
          quarter: data,
          courseIndex: event.newIndex!,
        };
        const revision = moveQuarterSlot(currentPlan.id, sourceQuarter, addToQuarter);
        dispatch(reviseRoadmap(revision));
        dispatch(setActiveCourse(null));
        return;
      }
    }

    // Otherwise, this is a course coming from outside (catalog/requirements); add as a new single.
    const addToQuarter: ModifiedQuarter = {
      startYear,
      quarter: data,
      courseIndex: event.newIndex!,
    };
    const revision = modifyQuarterCourse(currentPlan.id, activeCourse!, null, addToQuarter);
    dispatch(reviseRoadmap(revision));
  };

  const sortCourse = (event: SortableEvent) => {
    if (event.from !== event.to) return;
    const targetIndex = abTargetSlotIndexRef.current;
    const draggedSlot = data.courses[event.oldIndex!];
    // When we had an A/B target (single or A/B sub), onEnd handles the drop because
    // onSort often doesn't fire when the move was blocked. Skip here to avoid double-apply.
    if (targetIndex != null && activeCourseDraggedFrom?.courseIndex != null) {
      return;
    }
    const quarterToChange = { startYear, quarter: data, courseIndex: event.newIndex! };
    const revision = reorderQuarterCourse(currentPlan.id, draggedSlot, event.oldIndex!, quarterToChange);
    dispatch(reviseRoadmap(revision));
  };

  useEffect(() => {
    if (!moveCourseTrigger || activeCourseLoading) return; // nothing to add

    const addToQuarter: ModifiedQuarter = {
      startYear,
      quarter: data,
      courseIndex: moveCourseTrigger.courseIndex,
    };
    const revision = modifyQuarterCourse(currentPlan.id, activeCourse!, null, addToQuarter);
    dispatch(reviseRoadmap(revision));

    setMoveCourseTrigger(null);
    dispatch(setActiveCourse(null));
  }, [
    dispatch,
    moveCourseTrigger,
    activeCourseLoading,
    quarterIndex,
    yearIndex,
    startYear,
    data,
    currentPlan.id,
    activeCourse,
  ]);

  const setDraggedItem = (event: SortableEvent) => {
    const slotIndex = event.oldIndex!;
    const slot = data.courses[slotIndex];
    const course = getSlotCourses(slot)[0];
    dispatch(setActiveCourse({ course, startYear, quarter: data, courseIndex: slotIndex }));
  };

  return (
    <Card
      className={`quarter ${abTargetSlotIndex != null && !isReorderingWithinQuarter ? 'quarter--ab-target-active' : ''}`}
      ref={quarterContainerRef}
      variant="outlined"
      data-year-index={yearIndex}
      data-quarter-index={quarterIndex}
    >
      <div className="quarter-header">
        <h2 className="quarter-title">{quarterTitle.replace('10 Week', '10wk')}</h2>
        <div className="quarter-units">
          {unitCount} unit{pluralize(unitCount)}
        </div>
        {isMobile && (
          <Button
            startIcon={<PlaylistAddIcon />}
            onClick={() => dispatch(showMobileCatalog({ year: yearIndex, quarter: quarterIndex }))}
            size="small"
            variant="contained"
            color="inherit"
            disableElevation
          >
            Add Course
          </Button>
        )}
      </div>
      <ReactSortable<QuarterSlot>
        list={coursesCopy}
        className={`quarter-course-list ${isDragging ? 'dropzone-active' : ''}`}
        onStart={setDraggedItem}
        onAdd={addCourse}
        onSort={sortCourse}
        onMove={handleSortableMove}
        onEnd={(evt: SortableEvent) => {
          // Only run same-quarter merge when drop actually landed in this list (event.from === event.to).
          // If we dropped in another quarter, Sortable's onAdd handles it; merging here would duplicate.
          const droppedInSameList = evt.from === evt.to;
          const targetIdx = abTargetSlotIndexRef.current;
          const targetSub = abTargetSubIndexRef.current;
          const draggedIdx = activeCourseDraggedFrom?.courseIndex;
          const isReorderSameQuarter =
            droppedInSameList &&
            activeCourseDraggedFrom &&
            draggedIdx != null &&
            targetIdx != null &&
            activeCourseDraggedFrom.startYear === startYear &&
            activeCourseDraggedFrom.quarter?.name === data.name;

          if (isReorderSameQuarter) {
            const targetSlot = data.courses[targetIdx];
            const draggedSlot = data.courses[draggedIdx!];
            if (draggedSlot && draggedIdx !== targetIdx) {
              if (targetSlot?.type === 'ab' && targetSub != null) {
                const revision = swapAbChoiceSubWithSlot(
                  currentPlan.id,
                  startYear,
                  data,
                  targetIdx,
                  targetSub,
                  draggedIdx!,
                  draggedSlot,
                );
                dispatch(reviseRoadmap(revision));
                dispatch(setActiveCourse(null));
              } else if (targetSlot?.type === 'single') {
                const revision = mergeSlotWithDraggedCourse(
                  currentPlan.id,
                  startYear,
                  data,
                  draggedIdx!,
                  targetIdx,
                  draggedSlot,
                );
                dispatch(reviseRoadmap(revision));
                dispatch(setActiveCourse(null));
              }
            }
          }
          if (!activeCourseLoading) dispatch(setActiveCourse(null));
          if (abTargetTimerRef.current) {
            clearTimeout(abTargetTimerRef.current);
            abTargetTimerRef.current = null;
          }
          if (reorderDelayTimerRef.current) {
            clearTimeout(reorderDelayTimerRef.current);
            reorderDelayTimerRef.current = null;
          }
          pendingAbTargetIndexRef.current = null;
          reorderAllowedRef.current = false;
          setAbTargetSlotIndex(null);
          setAbTargetSubIndex(null);
        }}
        {...quarterSortable}
      >
        {data.courses.map((slot, index) => (
          <div
            key={index}
            ref={(el) => {
              slotRefs.current[index] = el;
            }}
            className="quarter-course-slot-wrapper"
            data-slot-index={index}
          >
            <QuarterCourseSlot
              slot={slot}
              index={index}
              yearIndex={yearIndex}
              quarterIndex={quarterIndex}
              invalidCourses={invalidCourses}
              removeCourseAt={removeCourseAt}
              removeAbSubAt={removeAbSubAt}
              onSwapAbAt={swapAbAt}
              isAbTarget={abTargetSlotIndex === index}
              isAbTargetSub={abTargetSlotIndex === index ? abTargetSubIndex : null}
            />
          </div>
        ))}
      </ReactSortable>
    </Card>
  );
};

export default Quarter;
