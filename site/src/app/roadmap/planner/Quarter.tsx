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
import { Button, Card } from '@mui/material';
import {
  mergeSlotWithDraggedCourse,
  ModifiedQuarter,
  modifyQuarterCourse,
  reorderQuarterCourse,
  removeAbChoiceSub,
  replaceAbChoiceSub,
  replaceSlotWithAbChoice,
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

  return (
    <div className={`quarter-course-slot ${isAb ? 'quarter-course-slot--ab' : ''} ${targetClass}`}>
      {isAb ? (
        <>
          <div className="quarter-course-slot__half quarter-course-slot__half--a">
            <Course
              key="a"
              data={slot.a}
              requiredCourses={requiredCourses}
              onDelete={removeAbSubAt ? () => removeAbSubAt(index, 0) : () => removeCourseAt(index)}
              addMode="drag"
              openPopoverLeft
            />
          </div>
          <div className="ab-or-divider" aria-hidden>
            or
          </div>
          <div className="quarter-course-slot__half quarter-course-slot__half--b">
            <Course
              key="b"
              data={slot.b}
              requiredCourses={requiredCourses}
              onDelete={removeAbSubAt ? () => removeAbSubAt(index, 1) : () => removeCourseAt(index)}
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

  // The confirmed A/B target: slot index and, for A/B slots, which half (0=left, 1=right; null=whole slot)
  const [abTargetSlotIndex, setAbTargetSlotIndex] = useState<number | null>(null);
  const [abTargetSubIndex, setAbTargetSubIndex] = useState<0 | 1 | null>(null);
  const abTargetSlotIndexRef = useRef<number | null>(null);
  const abTargetSubIndexRef = useRef<0 | 1 | null>(null);
  abTargetSlotIndexRef.current = abTargetSlotIndex;
  abTargetSubIndexRef.current = abTargetSubIndex;

  // Refs to each slot element
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);

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
  }, [isPhysicalDrag, data.courses.length, isReorderingWithinQuarter, activeCourseDraggedFrom?.courseIndex]);

  const handleSortableMove = useCallback(() => {
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
  }, [data.courses.length, isReorderingWithinQuarter, activeCourseDraggedFrom?.courseIndex]);

  const addCourse = async (event: SortableEvent) => {
    const targetIndex = abTargetSlotIndexRef.current;
    const targetSubIndex = abTargetSubIndexRef.current;
    if (targetIndex !== null && targetIndex !== undefined && !activeCourseLoading && activeCourse) {
      const targetSlot = data.courses[targetIndex];
      if (targetSlot.type === 'ab' && targetSubIndex !== null && targetSubIndex !== undefined) {
        const revision = replaceAbChoiceSub(currentPlan.id, startYear, data, targetIndex, targetSubIndex, activeCourse);
        dispatch(reviseRoadmap(revision));
        dispatch(setActiveCourse(null));
        return;
      }
      const existingCourse = getSlotCourses(targetSlot)[0];
      const revision = replaceSlotWithAbChoice(
        currentPlan.id,
        startYear,
        data,
        targetIndex,
        existingCourse,
        activeCourse,
      );
      dispatch(reviseRoadmap(revision));
      dispatch(setActiveCourse(null));
      return;
    }

    const target = { yearIndex, quarterIndex, courseIndex: event.newIndex! };
    if (activeCourseLoading) {
      dispatch(createQuarterCourseLoadingPlaceholder(target));
      setMoveCourseTrigger(target);
      return;
    }

    const sourceQuarter = (activeCourseDraggedFrom ?? null) as ModifiedQuarter | null;
    const addToQuarter: ModifiedQuarter = {
      startYear,
      quarter: data,
      courseIndex: event.newIndex!,
    };
    const revision = modifyQuarterCourse(currentPlan.id, activeCourse!, sourceQuarter, addToQuarter);
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
    const slot = data.courses[event.oldIndex!];
    const course = getSlotCourses(slot)[0];
    dispatch(setActiveCourse({ course, startYear, quarter: data, courseIndex: event.oldIndex! }));
  };

  return (
    <Card
      className={`quarter ${abTargetSlotIndex != null && !isReorderingWithinQuarter ? 'quarter--ab-target-active' : ''}`}
      ref={quarterContainerRef}
      variant="outlined"
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
        onEnd={() => {
          // When we block the move (center zone), onSort may not fire. Handle both A/B creation
          // (drop on single slot) and A/B sub-swap (drop on left/right of existing A/B) here.
          const targetIdx = abTargetSlotIndexRef.current;
          const targetSub = abTargetSubIndexRef.current;
          const draggedIdx = activeCourseDraggedFrom?.courseIndex;
          const isReorderSameQuarter =
            activeCourseDraggedFrom &&
            draggedIdx != null &&
            targetIdx != null &&
            activeCourseDraggedFrom.startYear === startYear &&
            activeCourseDraggedFrom.quarter?.name === data.name;

          if (isReorderSameQuarter) {
            const targetSlot = data.courses[targetIdx];
            const draggedSlot = data.courses[draggedIdx];
            if (draggedSlot && draggedIdx !== targetIdx) {
              if (targetSlot?.type === 'ab' && targetSub != null) {
                const revision = swapAbChoiceSubWithSlot(
                  currentPlan.id,
                  startYear,
                  data,
                  targetIdx,
                  targetSub,
                  draggedIdx,
                  draggedSlot,
                );
                dispatch(reviseRoadmap(revision));
                dispatch(setActiveCourse(null));
              } else if (targetSlot?.type === 'single') {
                const revision = mergeSlotWithDraggedCourse(
                  currentPlan.id,
                  startYear,
                  data,
                  draggedIdx,
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
          >
            <QuarterCourseSlot
              slot={slot}
              index={index}
              yearIndex={yearIndex}
              quarterIndex={quarterIndex}
              invalidCourses={invalidCourses}
              removeCourseAt={removeCourseAt}
              removeAbSubAt={removeAbSubAt}
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
